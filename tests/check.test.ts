import { describe, expect, test } from "bun:test";

import { buildCheckArgs, parseArgs } from "#lib/check";

describe("buildCheckArgs", () => {
	test.each([
		{
			name: "uses auto-discovered config by default",
			configPath: "",
			additionalArgs: "",
			expected: ["check"],
		},
		{
			name: "passes a config path as one argument",
			configPath: "config files/dprint.json",
			additionalArgs: "",
			expected: ["check", "--config", "config files/dprint.json"],
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
		expect(() => parseArgs("--excludes \"source files")).toThrow("Unterminated quote");
	});
});
