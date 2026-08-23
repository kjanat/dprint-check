import { describe, expect, mock, spyOn, test } from "bun:test";
import { resolve } from "node:path";

import { buildCheckArgs, checkFormatting, isFormattingFailure, parseArgs, parseCheckAnnotations } from "#lib/check";
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

describe("parseCheckAnnotations", () => {
	test("finds files and original lines in dprint diffs", () => {
		const output = [
			"\u001B[31mfrom\u001B[0m src/first.ts:",
			"  12|-old text",
			"12  |+new text",
			"--",
			"from src/line-endings.ts:",
			" | Text differed by line endings.",
			"--",
			"from D:\\code\\windows.ts:",
			"10 15|-old text",
			"--",
		].join("\n");

		expect(parseCheckAnnotations(output, false)).toEqual([
			{ file: "src/first.ts", line: 12 },
			{ file: "src/line-endings.ts" },
			{ file: "D:\\code\\windows.ts", line: 15 },
		]);
	});

	test("parses list-different output", () => {
		expect(parseCheckAnnotations(`${resolve("src/first.ts")}\r\nsrc/second.ts\r\n`, true)).toEqual([
			{ file: "src/first.ts" },
			{ file: "src/second.ts" },
		]);
	});
});

test("runs dprint check with the constructed argv and replays output", async () => {
	const execute = mock(async () => ({ stdout: "checked\n", stderr: "detail\n" }));
	const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
	const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

	try {
		await checkFormatting(TEST_DPRINT_BINARY, "config files/dprint.json", "--allow-no-files", { execute });
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledWith(
			TEST_DPRINT_BINARY,
			[DPRINT.command.check, DPRINT.command.config, "config files/dprint.json", "--allow-no-files"],
			{ maxBuffer: 64 * 1024 * 1024 },
		);
		expect(stdout).toHaveBeenCalledWith("checked\n");
		expect(stderr).toHaveBeenCalledWith("detail\n");
	} finally {
		stdout.mockRestore();
		stderr.mockRestore();
	}
});

test("annotates formatting failures and preserves the rejected error", async () => {
	const failure = Object.assign(new Error("dprint check failed"), {
		code: 20,
		stdout: "from src/example.ts:\n  7|-old\n7  |+new\n--\n",
		stderr: "Found 1 not formatted file. Run dprint fmt to fix.\n",
	});
	const listFailure = Object.assign(new Error("dprint check failed"), {
		code: 20,
		stdout: `${resolve("src/example.ts")}\n`,
	});
	const execute = mock(async () => Promise.reject(execute.mock.calls.length === 1 ? failure : listFailure));
	const annotate = mock(() => {});
	const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
	const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

	try {
		expect(checkFormatting(TEST_DPRINT_BINARY, "", "", { execute, annotate })).rejects.toBe(failure);
		expect(execute).toHaveBeenNthCalledWith(2, TEST_DPRINT_BINARY, [
			DPRINT.command.check,
			DPRINT.command.listDifferent,
		], { maxBuffer: 64 * 1024 * 1024 });
		expect(annotate).toHaveBeenCalledTimes(1);
		expect(annotate).toHaveBeenCalledWith("File is not formatted. Run dprint fmt to fix.", {
			file: "src/example.ts",
			title: "dprint check",
		});
		expect(isFormattingFailure(failure)).toBeTrue();
		expect(stdout).toHaveBeenCalledWith(failure.stdout);
		expect(stderr).toHaveBeenCalledWith(failure.stderr);
	} finally {
		stdout.mockRestore();
		stderr.mockRestore();
	}
});

test("does not annotate non-formatting failures", async () => {
	const failure = Object.assign(new Error("invalid configuration"), { code: 1, stderr: "invalid config\n" });
	const execute = mock(async () => Promise.reject(failure));
	const annotate = mock(() => {});
	const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

	try {
		expect(checkFormatting(TEST_DPRINT_BINARY, "", "", { execute, annotate })).rejects.toBe(failure);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(annotate).not.toHaveBeenCalled();
		expect(isFormattingFailure(failure)).toBeFalse();
	} finally {
		stderr.mockRestore();
	}
});

test("can disable formatting annotations", async () => {
	const failure = Object.assign(new Error("dprint check failed"), {
		code: 20,
		stdout: "from src/example.ts:\n  7|-old\n7  |+new\n--\n",
	});
	const execute = mock(async () => Promise.reject(failure));
	const annotate = mock(() => {});
	const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);

	try {
		expect(checkFormatting(TEST_DPRINT_BINARY, "", "", { annotations: false, execute, annotate })).rejects.toBe(
			failure,
		);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(annotate).not.toHaveBeenCalled();
		expect(isFormattingFailure(failure)).toBeTrue();
		expect(stdout).toHaveBeenCalledWith(failure.stdout);
	} finally {
		stdout.mockRestore();
	}
});
