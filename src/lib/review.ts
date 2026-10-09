import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { env } from "node:process";

import { info, warning } from "#lib/actions";
import { describeError } from "#lib/error";
import { execFileAsync } from "#lib/exec";
import { GITHUB_API } from "#lib/github";
import { type ExistingSuggestion, readExistingSuggestions, suggestionKey } from "#lib/review-threads";
import {
	createSuggestions,
	type FormattingDiff,
	type FormattingSuggestion,
	repositoryPath,
	suggestionBody,
} from "#lib/suggestions";

interface ReviewContext {
	repository: string;
	number: number;
	sha: string;
}

interface ReviewComment {
	path: string;
	line: number;
	side: "RIGHT";
	start_line?: number;
	start_side?: "RIGHT";
	body: string;
}

export interface ReviewOptions {
	token: string;
	environment?: NodeJS.ProcessEnv;
	fetch?: typeof globalThis.fetch;
	readEvent?: (path: string) => Promise<string>;
	checkoutSha?: (workspace: string) => Promise<string>;
	cleanFile?: (workspace: string, path: string) => Promise<boolean>;
	onInfo?: (message: string) => void;
	onWarning?: (message: string) => void;
}

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const reviewContext = (value: unknown, repository: string): ReviewContext => {
	if (!record(value) || !record(value.pull_request)) throw new Error("Missing pull request event");
	const { number, head, base } = value.pull_request;
	if (
		!Number.isSafeInteger(number) || typeof number !== "number" || number < 1
		|| !record(head) || typeof head.sha !== "string" || !/^[a-f\d]{40}$/iu.test(head.sha)
		|| !record(base) || !record(base.repo) || base.repo.full_name !== repository
	) throw new Error("Invalid pull request review context");
	return { repository, number, sha: head.sha };
};

/** New-side line intervals in each PR hunk; a suggestion must fit one complete interval. */
const commentableRanges = (patch: string): Array<{ start: number; end: number }> => {
	const ranges: Array<{ start: number; end: number }> = [];
	for (const line of patch.split(/\r?\n/u)) {
		const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
		if (match === null) continue;
		const start = Number(match[1]);
		const count = match[2] === undefined ? 1 : Number(match[2]);
		if (start > 0 && count > 0) ranges.push({ start, end: start + count - 1 });
	}
	return ranges;
};

const reviewComment = (suggestion: FormattingSuggestion): ReviewComment => ({
	path: suggestion.path,
	line: suggestion.endLine,
	side: "RIGHT",
	...(suggestion.startLine === suggestion.endLine ? {} : {
		start_line: suggestion.startLine,
		start_side: "RIGHT",
	}),
	body: suggestionBody(suggestion.replacement),
});

/** Conflicting results from different config roots cannot produce a trustworthy replacement. */
const uniqueDiffs = (diffs: readonly FormattingDiff[]): FormattingDiff[] => {
	const files = new Map<string, FormattingDiff | null>();
	for (const diff of diffs) {
		const previous = files.get(diff.file);
		files.set(diff.file, previous === undefined || previous?.diff === diff.diff ? diff : null);
	}
	return [...files.values()].filter(diff => diff !== null);
};

/** Review publication is best effort and never changes the formatter's exit status. */
export const postFormattingReview = async (
	diffs: readonly FormattingDiff[],
	options: ReviewOptions,
): Promise<readonly ExistingSuggestion[]> => {
	if (diffs.length === 0) return [];
	const environment = options.environment ?? env;
	const reportInfo = options.onInfo ?? info;
	const reportWarning = options.onWarning ?? warning;
	if (environment.GITHUB_EVENT_NAME !== "pull_request") {
		reportInfo("Formatting review skipped: this is not a pull_request run");
		return [];
	}
	try {
		const { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: repository, GITHUB_WORKSPACE: workspace } = environment;
		if (eventPath === undefined || repository === undefined || workspace === undefined) {
			throw new Error("Missing GitHub pull request environment");
		}
		if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error("Invalid GitHub repository");
		const event: unknown = JSON.parse(await (options.readEvent ?? (path => readFile(path, "utf8")))(eventPath));
		const context = reviewContext(event, repository);
		const checkoutSha = await (options.checkoutSha ?? (async directory => {
			const output = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory });
			return output.stdout.trim();
		}))(workspace);
		if (checkoutSha !== context.sha) {
			throw new Error("Checkout must match the PR head commit to place formatting suggestions");
		}
		const baseUrl = (environment.GITHUB_API_URL ?? GITHUB_API.baseUrl).replace(/\/$/u, "");
		const fetch = options.fetch ?? globalThis.fetch;
		const headers = {
			accept: GITHUB_API.jsonMediaType,
			"user-agent": GITHUB_API.userAgent,
			"x-github-api-version": GITHUB_API.version,
			"content-type": "application/json",
			authorization: `Bearer ${options.token}`,
		};
		const request = async (route: string, body?: unknown): Promise<unknown> => {
			const suffix = route === "" ? "" : `/${route}`;
			const response = await fetch(`${baseUrl}/repos/${context.repository}/pulls/${context.number}${suffix}`, {
				method: body === undefined ? "GET" : "POST",
				headers,
				signal: AbortSignal.timeout(15_000),
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			if (!response.ok) throw new Error(`PR review API returned HTTP ${response.status}`);
			return response.json();
		};
		const pages = async (route: string): Promise<unknown[]> => {
			const entries: unknown[] = [];
			for (let page = 1;; page++) {
				const value = await request(`${route}?per_page=100&page=${page}`);
				if (!Array.isArray(value)) throw new Error(`Invalid PR ${route} response`);
				entries.push(...value);
				if (value.length < 100) return entries;
			}
		};
		const ensureCurrentHead = async (): Promise<void> => {
			const pull = await request("");
			if (!record(pull) || !record(pull.head) || pull.head.sha !== context.sha) {
				throw new Error("PR head changed; rerun the formatting check before posting suggestions");
			}
		};
		await ensureCurrentHead();
		const files = await pages("files");
		const ranges = new Map<string, Array<{ start: number; end: number }>>();
		for (const file of files) {
			if (!record(file) || typeof file.filename !== "string") throw new Error("Invalid PR file response");
			if (typeof file.patch === "string") ranges.set(file.filename, commentableRanges(file.patch));
		}
		const normalizedDiffs = diffs.flatMap(diff => {
			const file = repositoryPath(diff.file, workspace);
			return file === undefined ? [] : [{ file, diff: diff.diff }];
		});
		const suggestions = createSuggestions(uniqueDiffs(normalizedDiffs), workspace);
		const cleanFile = options.cleanFile ?? (async (directory: string, path: string): Promise<boolean> => {
			try {
				await execFileAsync("git", ["diff", "--quiet", "HEAD", "--", path], { cwd: directory });
				return true;
			} catch (error) {
				if (record(error) && error.code === 1) return false;
				throw error;
			}
		});
		const cleanPaths = new Set<string>();
		for (const path of new Set(suggestions.map(suggestion => suggestion.path))) {
			if (await cleanFile(workspace, path)) cleanPaths.add(path);
		}
		const eligible = suggestions.filter(suggestion =>
			cleanPaths.has(suggestion.path)
			&& ranges.get(suggestion.path)?.some(range =>
				suggestion.startLine >= range.start && suggestion.endLine <= range.end
			)
		);
		const graphqlUrl = environment.GITHUB_GRAPHQL_URL ?? `${baseUrl.replace(/\/api\/v3$/u, "/api")}/graphql`;
		const existing = await readExistingSuggestions(context.repository, context.number, async (query, variables) => {
			const response = await fetch(graphqlUrl, {
				method: "POST",
				headers,
				body: JSON.stringify({ query, variables }),
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) throw new Error(`PR review thread API returned HTTP ${response.status}`);
			return response.json();
		});
		const existingKeys = new Set(existing.map(suggestionKey));
		const covered = eligible.filter(suggestion => existingKeys.has(suggestionKey(suggestion)));
		const comments = eligible.filter(suggestion => !existingKeys.has(suggestionKey(suggestion)))
			.map(reviewComment).toSorted((first, second) =>
				first.path.localeCompare(second.path) || first.line - second.line || first.body.localeCompare(second.body)
			);
		if (eligible.length !== 0 && comments.length === 0) {
			await ensureCurrentHead();
			reportInfo("Formatting review already exists for every suggestion");
			return covered;
		}
		const omitted = suggestions.length - eligible.length;
		const summary = `${
			new Set(diffs.map(diff => diff.file)).size
		} file(s) need formatting. ${comments.length} suggestion(s).`
			+ "\n\nRun `dprint fmt` to apply all formatting changes."
			+ (covered.length === 0 ? "" : `\n\n${covered.length} suggestion(s) already exist in active review threads.`)
			+ (omitted === 0
				? ""
				: `\n\n${omitted} change(s) fall outside commentable PR ranges or affect modified checkout files.`);
		const canonicalDiffs = [...new Set(normalizedDiffs.map(diff => JSON.stringify(diff)))].toSorted();
		const fingerprint = createHash("sha256").update(
			JSON.stringify({ sha: context.sha, diffs: canonicalDiffs, comments }),
		).digest("hex");
		const marker = `<!-- dprint-review:${context.sha}:${fingerprint} -->`;
		// Summary-only reviews have no inline threads. Live threads are authoritative for suggestions.
		if (eligible.length === 0) {
			const reviews = await pages("reviews");
			if (
				reviews.some(review =>
					record(review) && review.commit_id === context.sha && review.state !== "PENDING"
					&& typeof review.body === "string" && review.body.includes(marker)
				)
			) {
				reportInfo("Formatting review already exists for this result");
				return [];
			}
		}
		// POST deliberately has no automatic retry: an ambiguous response could duplicate the entire review.
		await ensureCurrentHead();
		await request("reviews", { commit_id: context.sha, event: "COMMENT", body: `${summary}\n\n${marker}`, comments });
		reportInfo(`Posted one formatting review with ${comments.length} suggestion(s)`);
		return covered;
	} catch (error) {
		reportWarning(`Formatting review skipped: ${describeError(error)}`);
		return [];
	}
};
