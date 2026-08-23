import { describe, expect, mock, test } from "bun:test";

import { buildCheckArgs, checkFormatting, parseArgs } from "#lib/check";
import { DPRINT } from "#lib/contracts";
import { TEST_DPRINT_BINARY } from "#test/helpers";

describe("buildCheckArgs", () => {
	test.each([
		{
			name: "uses auto-discovered config by default",
			configPath: "",
			additionalArgs: "",
			expected: [DPRINT.command.check],
		},
		{
			name: "passes a config path as one argument",
			configPath: "config files/dprint.json",
			additionalArgs: "",
			expected: [DPRINT.command.check, DPRINT.command.config, "config files/dprint.json"],
		},
		{
			name: "passes a remote config URL unchanged",
			configPath: "https://example.com/configs/dprint.json",
			additionalArgs: "",
			expected: [DPRINT.command.check, DPRINT.command.config, "https://example.com/configs/dprint.json"],
		},
		{
			name: "parses quoted arguments without invoking a shell",
			configPath: "",
			additionalArgs: "--allow-no-files 'source files/**/*.ts'",
			expected: ["check", "--allow-no-files", "source files/**/*.ts"],
		},
	])("$name", ({ configPath, additionalArgs, expected }) => {
		expect(buildCheckArgs(configPath, additionalArgs)).toEqual([...expected]);
	});

	test("rejects an unterminated quote", () => {
		expect(() => parseArgs("--excludes \"source files")).toThrow(/^Unterminated quote in args input$/u);
	});
});

describe("parseArgs", () => {
	test.each(
		[
			{
				name: "double-quoted whitespace",
				input: "--config \"config files/dprint.json\"",
				expected: ["--config", "config files/dprint.json"],
			},
			{
				name: "escaped double quote",
				input: "--pattern \"say \\\"hello\\\"\"",
				expected: ["--pattern", "say \"hello\""],
			},
			{ name: "literal backslash", input: "--pattern \"src\\\\generated\"", expected: ["--pattern", "src\\generated"] },
			{ name: "empty quoted argument", input: "--pattern \"\"", expected: ["--pattern", ""] },
		] as const,
	)("parses $name", ({ input, expected }) => {
		expect(parseArgs(input)).toEqual([...expected]);
	});
});

test("runs dprint check with the constructed argv", async () => {
	const execute = mock(async () => 0);

	await checkFormatting(TEST_DPRINT_BINARY, "config files/dprint.json", "--allow-no-files", execute);
	expect(execute).toHaveBeenCalledTimes(1);
	expect(execute).toHaveBeenCalledWith(
		TEST_DPRINT_BINARY,
		[DPRINT.command.check, DPRINT.command.config, "config files/dprint.json", "--allow-no-files"],
	);
});
