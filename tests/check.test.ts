import { describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
	buildCheckArgs,
	checkConfigurations,
	checkFormatting,
	isFormattingFailure,
	parseArgs,
	parseCheckAnnotations,
} from "#lib/check";
import { DPRINT, ENVIRONMENT } from "#lib/contracts";
import { TEST_DPRINT_BINARY, useTestContext } from "#test/helpers";

const context = useTestContext();
const fixture = (stream: "stderr" | "stdout", name: string): string =>
	readFileSync(new URL(`./fixtures/dprint/${stream}/${name}.txt`, import.meta.url), "utf8");

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

	test("enables dprint debug logging without overriding an explicit log level", () => {
		expect(buildCheckArgs("", "", true)).toEqual([
			DPRINT.command.check,
			DPRINT.command.logLevel,
			DPRINT.logLevel.debug,
		]);
		expect(buildCheckArgs("", `${DPRINT.command.logLevel} warn`, true)).toEqual([
			DPRINT.command.check,
			DPRINT.command.logLevel,
			"warn",
		]);
		expect(buildCheckArgs("", `${DPRINT.command.logLevel}=error`, true)).toEqual([
			DPRINT.command.check,
			`${DPRINT.command.logLevel}=error`,
		]);
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
	test.each(
		[
			{
				name: "TypeScript replacements",
				fixture: "check-typescript",
				expected: [{ file: "typescript.ts", line: 1, endLine: 3 }],
			},
			{
				name: "Markdown non-contiguous replacements",
				fixture: "check-markdown",
				expected: [{ file: "markdown.md", line: 3, endLine: 6 }],
			},
			{
				name: "PowerShell single-line replacements",
				fixture: "check-powershell",
				expected: [{ file: "powershell.ps1", line: 1 }],
			},
			{
				name: "distant TypeScript replacements",
				fixture: "check-noncontiguous",
				expected: [{ file: "noncontiguous.ts", line: 1, endLine: 10 }],
			},
			{
				name: "line-ending-only changes",
				fixture: "check-line-endings",
				expected: [{ file: "line-endings.ts" }],
			},
			{
				name: "multiple plugins and files",
				fixture: "check-multifile",
				expected: [
					{ file: "markdown.md", line: 3, endLine: 6 },
					{ file: "powershell.ps1", line: 1 },
					{ file: "typescript.ts", line: 1, endLine: 3 },
				],
			},
		] as const,
	)("parses $name from captured stdout", ({ fixture: name, expected }) => {
		context.setEnvironment(ENVIRONMENT.githubWorkspace, "/workspace");
		expect(parseCheckAnnotations(fixture("stdout", name), false)).toEqual([...expected]);
	});

	test("parses captured list-different stdout", () => {
		context.setEnvironment(ENVIRONMENT.githubWorkspace, "/workspace");
		expect(parseCheckAnnotations(fixture("stdout", "list-different"), true)).toEqual([
			{ file: "markdown.md" },
			{ file: "powershell.ps1" },
			{ file: "typescript.ts" },
		]);
	});

	test.each(["check-debug", "list-different-debug"])("does not parse %s stderr as a diff", name => {
		expect(parseCheckAnnotations(fixture("stderr", name), false)).toBeEmpty();
	});

	test("keeps absolute paths outside the workspace", () => {
		context.setEnvironment(ENVIRONMENT.githubWorkspace, "/workspace");
		expect(parseCheckAnnotations(`${resolve("src/first.ts")}\r\nsrc/second.ts\r\n`, true)).toEqual([
			{ file: resolve("src/first.ts") },
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

test("checks every explicit configuration", async () => {
	const execute = mock(async () => ({}));

	await checkConfigurations(TEST_DPRINT_BINARY, ["first.json", "https://example.com/second.json"], "", { execute });

	expect(execute).toHaveBeenCalledTimes(2);
	expect(execute).toHaveBeenNthCalledWith(
		1,
		TEST_DPRINT_BINARY,
		[DPRINT.command.check, DPRINT.command.config, "first.json"],
		{ maxBuffer: 64 * 1024 * 1024 },
	);
	expect(execute).toHaveBeenNthCalledWith(
		2,
		TEST_DPRINT_BINARY,
		[DPRINT.command.check, DPRINT.command.config, "https://example.com/second.json"],
		{ maxBuffer: 64 * 1024 * 1024 },
	);
});

test("annotates captured formatting failures from stdout and preserves both output streams", async () => {
	const failure = Object.assign(new Error("dprint check failed"), {
		code: 20,
		stdout: fixture("stdout", "check-multifile"),
		stderr: fixture("stderr", "check-debug"),
	});
	const listFailure = Object.assign(new Error("dprint check failed"), {
		code: 20,
		stdout: fixture("stdout", "list-different"),
		stderr: fixture("stderr", "list-different-debug"),
	});
	const execute = mock(async () => Promise.reject(execute.mock.calls.length === 1 ? failure : listFailure));
	const annotate = mock(() => {});
	const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
	const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

	try {
		context.setEnvironment(ENVIRONMENT.githubWorkspace, "/workspace");
		expect(checkFormatting(TEST_DPRINT_BINARY, "", "", { execute, annotate, debug: true })).rejects.toBe(failure);
		expect(execute).toHaveBeenNthCalledWith(2, TEST_DPRINT_BINARY, [
			DPRINT.command.check,
			DPRINT.command.logLevel,
			DPRINT.logLevel.debug,
			DPRINT.command.listDifferent,
		], { maxBuffer: 64 * 1024 * 1024 });
		expect(annotate).toHaveBeenCalledTimes(3);
		expect(annotate).toHaveBeenNthCalledWith(1, "File is not formatted. Run dprint fmt to fix.", {
			endLine: 6,
			file: "markdown.md",
			line: 3,
			title: "dprint check",
		});
		expect(annotate).toHaveBeenNthCalledWith(2, "File is not formatted. Run dprint fmt to fix.", {
			file: "powershell.ps1",
			line: 1,
			title: "dprint check",
		});
		expect(annotate).toHaveBeenNthCalledWith(3, "File is not formatted. Run dprint fmt to fix.", {
			endLine: 3,
			file: "typescript.ts",
			line: 1,
			title: "dprint check",
		});
		expect(isFormattingFailure(failure)).toBeTrue();
		expect(stdout).toHaveBeenCalledTimes(1);
		expect(stdout).toHaveBeenCalledWith(failure.stdout);
		expect(stderr).toHaveBeenCalledTimes(1);
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
