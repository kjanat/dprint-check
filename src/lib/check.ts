import { DPRINT } from "#lib/contracts";
import { execFileAsync } from "#lib/exec";

interface ExecutionOutput {
	stderr?: string | Buffer;
	stdout?: string | Buffer;
}

interface CheckOptions {
	debug?: boolean;
	execute?: Execute;
}

type Execute = (commandLine: string, args: string[], options: { maxBuffer: number }) => Promise<unknown>;

const CHECK_MAX_BUFFER = 64 * 1024 * 1024;
const formattingFailures = new WeakSet<object>();

const asOutput = (value: unknown): ExecutionOutput => typeof value === "object" && value !== null ? value : {};

const writeOutput = ({ stderr, stdout }: ExecutionOutput): void => {
	if (stdout !== undefined && stdout.length !== 0) process.stdout.write(stdout);
	if (stderr !== undefined && stderr.length !== 0) process.stderr.write(stderr);
};

const exitCode = (error: unknown): number | string | undefined => {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "number" || typeof error.code === "string" ? error.code : undefined;
};

const isCheckFailure = (error: unknown): error is object =>
	typeof error === "object" && error !== null && Number(exitCode(error)) === DPRINT.checkFailureExitCode;

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

export const buildCheckArgs = (configPath: string, additionalArgs: string, debug = false): string[] => {
	const args: string[] = [DPRINT.command.check];
	if (configPath !== "") args.push(DPRINT.command.config, configPath);
	if (additionalArgs.trim() !== "") args.push(...parseArgs(additionalArgs));
	if (debug && !args.some(arg => arg === DPRINT.command.logLevel || arg.startsWith(`${DPRINT.command.logLevel}=`))) {
		args.push(DPRINT.command.logLevel, DPRINT.logLevel.debug);
	}
	return args;
};

export const checkFormatting = async (
	binaryPath: string,
	configPath: string,
	additionalArgs: string,
	options: CheckOptions = {},
): Promise<void> => {
	const { debug = false, execute = execFileAsync } = options;
	const args = buildCheckArgs(configPath, additionalArgs, debug);
	try {
		writeOutput(asOutput(await execute(binaryPath, args, { maxBuffer: CHECK_MAX_BUFFER })));
	} catch (error) {
		writeOutput(asOutput(error));
		if (isCheckFailure(error)) formattingFailures.add(error);
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
