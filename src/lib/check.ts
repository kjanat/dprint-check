import { DPRINT } from "#lib/contracts";
import { execFileAsync } from "#lib/exec";

type Execute = (commandLine: string, args: string[]) => Promise<unknown>;

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
	execute: Execute = execFileAsync,
): Promise<void> => {
	await execute(binaryPath, buildCheckArgs(configPath, additionalArgs));
};
