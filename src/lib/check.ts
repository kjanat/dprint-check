import { exec } from "@actions/exec";

export function parseArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | "\"" | undefined;
	let escaped = false;

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
			continue;
		}
		if (/\s/u.test(character)) {
			if (current !== "") {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}

	if (escaped) current += "\\";
	if (quote !== undefined) throw new Error("Unterminated quote in args input");
	if (current !== "") args.push(current);
	return args;
}

export function buildCheckArgs(configPath: string, additionalArgs: string): string[] {
	const args = ["check"];
	if (configPath !== "") args.push("--config", configPath);
	if (additionalArgs.trim() !== "") args.push(...parseArgs(additionalArgs));
	return args;
}

export async function checkFormatting(binaryPath: string, configPath: string, additionalArgs: string): Promise<void> {
	await exec(binaryPath, buildCheckArgs(configPath, additionalArgs));
}
