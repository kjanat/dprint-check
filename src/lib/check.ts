import { isAbsolute, relative, sep } from "node:path";
import { cwd, env } from "node:process";
import { stripVTControlCharacters } from "node:util";

import { error as annotateError } from "#lib/actions";
import { DPRINT, ENVIRONMENT } from "#lib/contracts";
import { execFileAsync } from "#lib/exec";

interface CheckAnnotation {
	file: string;
	line?: number;
}

interface ExecutionOutput {
	stderr?: string | Buffer;
	stdout?: string | Buffer;
}

interface CheckOptions {
	annotations?: boolean;
	annotate?: Annotate;
	execute?: Execute;
}

type Execute = (commandLine: string, args: string[], options: { maxBuffer: number }) => Promise<unknown>;
type Annotate = (message: string, properties: CheckAnnotation & { title: string }) => void;

const CHECK_MAX_BUFFER = 64 * 1024 * 1024;
const ANNOTATION_MESSAGE = "File is not formatted. Run dprint fmt to fix.";
const ANNOTATION_TITLE = "dprint check";
const formattingFailures = new WeakSet<object>();

const asOutput = (value: unknown): ExecutionOutput => typeof value === "object" && value !== null ? value : {};

const outputText = (value: string | Buffer | undefined): string => value === undefined ? "" : String(value);

const writeOutput = ({ stderr, stdout }: ExecutionOutput): void => {
	if (stdout !== undefined && stdout.length !== 0) process.stdout.write(stdout);
	if (stderr !== undefined && stderr.length !== 0) process.stderr.write(stderr);
};

const originalLine = (line: string): number | undefined => {
	const separator = line.indexOf("|");
	if (separator === -1 || line[separator + 1] !== "-") return undefined;
	const numbers = line.slice(0, separator).match(/\d+/gu);
	return numbers === null ? undefined : Number(numbers.at(-1));
};

const annotationPath = (file: string): string => {
	if (!isAbsolute(file)) return file;
	const path = relative(env[ENVIRONMENT.githubWorkspace] ?? cwd(), file);
	return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path) ? path : file;
};

export const parseCheckAnnotations = (output: string, listDifferent: boolean): CheckAnnotation[] => {
	const lines = stripVTControlCharacters(output).split(/\r?\n/u);
	if (listDifferent) return lines.filter((line) => line !== "").map((file) => ({ file: annotationPath(file) }));

	const annotations: CheckAnnotation[] = [];
	let current: CheckAnnotation | undefined;
	const finish = (): void => {
		if (current !== undefined) annotations.push(current);
		current = undefined;
	};

	for (const line of lines) {
		const header = /^from (.+):$/u.exec(line);
		if (header !== null) {
			const file = header[1];
			if (file === undefined) continue;
			finish();
			current = { file };
		} else if (line === "--") finish();
		else if (current !== undefined && current.line === undefined) {
			const lineNumber = originalLine(line);
			if (lineNumber !== undefined) current.line = lineNumber;
		}
	}
	finish();
	return annotations;
};

const exitCode = (error: unknown): number | string | undefined => {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "number" || typeof error.code === "string" ? error.code : undefined;
};

const isCheckFailure = (error: unknown): error is object =>
	typeof error === "object" && error !== null && Number(exitCode(error)) === DPRINT.checkFailureExitCode;

const listDifferent = async (binaryPath: string, args: string[], execute: Execute): Promise<ExecutionOutput> => {
	const listArgs = args.includes(DPRINT.command.listDifferent) ? args : [...args, DPRINT.command.listDifferent];
	try {
		return asOutput(
			await execute(binaryPath, listArgs, {
				maxBuffer: CHECK_MAX_BUFFER,
			}),
		);
	} catch (error) {
		return isCheckFailure(error) ? asOutput(error) : {};
	}
};

export const isFormattingFailure = (error: unknown): boolean =>
	typeof error === "object" && error !== null && formattingFailures.has(error);

export const parseArgs = (input: string): string[] => {
	const args: string[] = [];
	let current = "";
	let quote: "'" | "\"" | undefined;
	let escaped = false;
	let started = false;

	for (const character of input) {
		if (escaped) {
			if (character !== "\"" && character !== "\\") current += "\\";
			current += character;
			escaped = false;
			continue;
		}
		if (quote === "\"" && character === "\\") {
			escaped = true;
			continue;
		}
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "\"" || character === "'") {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/u.test(character)) {
			if (started) {
				args.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += character;
		started = true;
	}

	if (escaped) current += "\\";
	if (quote !== undefined) throw new Error("Unterminated quote in args input");
	if (started) args.push(current);
	return args;
};

export const buildCheckArgs = (configPath: string, additionalArgs: string): string[] => {
	const args: string[] = [DPRINT.command.check];
	if (configPath !== "") args.push(DPRINT.command.config, configPath);
	if (additionalArgs.trim() !== "") args.push(...parseArgs(additionalArgs));
	return args;
};

export const checkFormatting = async (
	binaryPath: string,
	configPath: string,
	additionalArgs: string,
	options: CheckOptions = {},
): Promise<void> => {
	const { annotations = true, annotate = annotateError, execute = execFileAsync } = options;
	const args = buildCheckArgs(configPath, additionalArgs);
	try {
		writeOutput(asOutput(await execute(binaryPath, args, { maxBuffer: CHECK_MAX_BUFFER })));
	} catch (error) {
		const output = asOutput(error);
		writeOutput(output);
		if (isCheckFailure(error)) {
			formattingFailures.add(error);
			if (!annotations) throw error;
			const listed = await listDifferent(binaryPath, args, execute);
			for (const properties of parseCheckAnnotations(outputText(listed.stdout), true)) {
				annotate(ANNOTATION_MESSAGE, { ...properties, title: ANNOTATION_TITLE });
			}
		}
		throw error;
	}
};

export const checkConfigurations = async (
	binaryPath: string,
	configPaths: readonly string[],
	additionalArgs: string,
	options: CheckOptions = {},
): Promise<void> => {
	let formattingFailure: unknown;
	for (const configPath of configPaths) {
		try {
			await checkFormatting(binaryPath, configPath, additionalArgs, options);
		} catch (error) {
			if (!isFormattingFailure(error)) throw error;
			formattingFailure ??= error;
		}
	}
	if (formattingFailure !== undefined) throw formattingFailure;
};
