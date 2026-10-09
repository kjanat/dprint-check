import { posix, win32 } from "node:path";

export interface FormattingDiff {
	file: string;
	diff: string;
}

export interface FormattingSuggestion {
	path: string;
	startLine: number;
	endLine: number;
	replacement: readonly string[];
}

type DiffLine =
	| { kind: "add"; text: string }
	| { kind: "context" | "remove"; text: string; oldLine: number };

interface Hunk {
	lines: DiffLine[];
	unsafe: boolean;
}

interface Span {
	start: number;
	end: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** dprint emits one JSON object per file, never a JSON array or pretty diff text. */
export const parseFormattingDiffs = (stdout: string): FormattingDiff[] => {
	const records: FormattingDiff[] = [];
	for (const line of stdout.split(/\r?\n/u)) {
		if (line.trim() === "") continue;
		const value: unknown = JSON.parse(line);
		if (!isRecord(value) || typeof value.file !== "string" || value.file === "" || typeof value.diff !== "string") {
			throw new Error("Invalid dprint JSON diff record");
		}
		records.push({ file: value.file, diff: value.diff });
	}
	return records;
};

export const repositoryPath = (file: string, workspace: string): string | undefined => {
	if (file.includes("\0")) return undefined;
	// Interpret Windows paths even when tests/reporting run on another platform.
	const windows = /^[A-Za-z]:[\\/]/u.test(workspace) || workspace.startsWith("\\\\");
	const paths = windows ? win32 : posix;
	if (!windows && (/^[A-Za-z]:[\\/]/u.test(file) || file.startsWith("\\\\"))) return undefined;
	const root = paths.resolve(workspace);
	const normalized = file.replaceAll("\\", "/");
	const target = paths.resolve(root, normalized);
	const path = paths.relative(root, target);
	if (path === "" || path === ".." || path.startsWith(`..${paths.sep}`) || paths.isAbsolute(path)) {
		return undefined;
	}
	return path.replaceAll("\\", "/");
};

const malformed = (): never => {
	throw new Error("Invalid unified dprint diff");
};

const parseHunks = (diff: string): Hunk[] => {
	// Header delimiters are LF; CR on a content line belongs to the source file.
	const lines = diff.split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (!lines[0]?.startsWith("--- ") || !lines[1]?.startsWith("+++ ")) return malformed();
	const hunks: Hunk[] = [];
	let index = 2;
	let previousOldEnd = 0;
	let previousNewEnd = 0;
	while (index < lines.length) {
		const header = lines[index]?.replace(/\r$/u, "");
		const match = header === undefined ? null : /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(header);
		if (match === null) return malformed();
		const oldStart = Number(match[1]);
		const oldCount = Number(match[2] ?? "1");
		const newStart = Number(match[3]);
		const newCount = Number(match[4] ?? "1");
		if (
			![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)
			|| (oldCount > 0 && oldStart < 1) || (newCount > 0 && newStart < 1)
			|| oldStart < previousOldEnd || newStart < previousNewEnd
		) return malformed();
		index++;
		let oldConsumed = 0;
		let newConsumed = 0;
		const hunk: Hunk = { lines: [], unsafe: false };
		while (index < lines.length && !lines[index]?.startsWith("@@ ")) {
			const line = lines[index];
			if (line === undefined) return malformed();
			index++;
			if (line.replace(/\r$/u, "") === "\\ No newline at end of file") {
				if (hunk.lines.length === 0) return malformed();
				// Suggestions cannot faithfully encode missing final newlines.
				hunk.unsafe = true;
				continue;
			}
			const text = line.slice(1);
			if (line.startsWith("+")) {
				hunk.lines.push({ kind: "add", text });
				newConsumed++;
			} else if (line.startsWith("-") || line.startsWith(" ")) {
				const kind = line.startsWith("-") ? "remove" : "context";
				hunk.lines.push({ kind, text, oldLine: oldStart + oldConsumed });
				oldConsumed++;
				if (kind === "context") newConsumed++;
			} else return malformed();
			if (oldConsumed > oldCount || newConsumed > newCount) return malformed();
		}
		if (oldConsumed !== oldCount || newConsumed !== newCount) return malformed();
		previousOldEnd = oldStart + oldCount;
		previousNewEnd = newStart + newCount;
		hunks.push(hunk);
	}
	return hunks;
};

const changeSpans = (lines: readonly DiffLine[]): Span[] => {
	const spans: Span[] = [];
	let index = 0;
	while (index < lines.length) {
		if (lines[index]?.kind === "context") {
			index++;
			continue;
		}
		let start = index;
		let hasOriginal = false;
		while (index < lines.length && lines[index]?.kind !== "context") {
			if (lines[index]?.kind === "remove") hasOriginal = true;
			index++;
		}
		let end = index - 1;
		if (!hasOriginal) {
			if (lines[start - 1]?.kind === "context") start--;
			else if (lines[index]?.kind === "context") end = index;
			else continue; // Insertion into an empty file has no commentable original line.
		}
		const previous = spans.at(-1);
		if (previous !== undefined && start <= previous.end) previous.end = end;
		else spans.push({ start, end });
	}
	return spans;
};

/** Keep independent changes separate; insertion anchors retain their original context. */
export const createSuggestions = (
	records: readonly FormattingDiff[],
	workspace: string,
): FormattingSuggestion[] => {
	const suggestions: FormattingSuggestion[] = [];
	for (const record of records) {
		const path = repositoryPath(record.file, workspace);
		if (path === undefined) continue;
		for (const hunk of parseHunks(record.diff)) {
			if (hunk.unsafe) continue;
			for (const span of changeSpans(hunk.lines)) {
				const changed = hunk.lines.slice(span.start, span.end + 1);
				const originals = changed.filter(line => line.kind !== "add");
				const first = originals[0];
				const last = originals.at(-1);
				if (first === undefined || last === undefined || first.oldLine < 1) continue;
				const replacementLines = changed.filter(line => line.kind !== "remove").map(line => line.text);
				// GitHub suggestions cannot reliably express changes to line endings alone.
				if (
					replacementLines.length === originals.length
					&& originals.every((line, index) =>
						line.text.replace(/\r$/u, "") === replacementLines[index]?.replace(/\r$/u, "")
					)
				) continue;
				suggestions.push({
					path,
					startLine: first.oldLine,
					endLine: last.oldLine,
					replacement: replacementLines,
				});
			}
		}
	}
	return suggestions;
};

export const suggestionBody = (replacement: readonly string[]): string => {
	const content = replacement.join("\n");
	const backticks = content.match(/`+/gu) ?? [];
	const fence = "`".repeat(backticks.reduce((length, run) => Math.max(length, run.length + 1), 3));
	return `${fence}suggestion\n${replacement.length === 0 ? "" : `${content}\n`}${fence}`;
};
