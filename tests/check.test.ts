import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";

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
	readFileSync(join(import.meta.dirname, "fixtures", "dprint", stream, `${name}.txt`), "utf8");

describe("buildCheckArgs", () => {
	const cases = [
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
	];

	for (const { name, configPath, additionalArgs, expected } of cases) {
		test(name, () => {
			assert.deepStrictEqual(buildCheckArgs(configPath, additionalArgs), [...expected]);
		});
	}

	test("rejects an unterminated quote", () => {
		assert.throws(() => parseArgs("--excludes \"source files"), { message: "Unterminated quote in args input" });
	});

	test("enables dprint debug logging without overriding an explicit log level", () => {
		assert.deepStrictEqual(buildCheckArgs("", "", true), [
			DPRINT.command.check,
			DPRINT.command.logLevel,
			DPRINT.logLevel.debug,
		]);
		assert.deepStrictEqual(buildCheckArgs("", `${DPRINT.command.logLevel} warn`, true), [
			DPRINT.command.check,
			DPRINT.command.logLevel,
			"warn",
		]);
		assert.deepStrictEqual(buildCheckArgs("", `${DPRINT.command.logLevel}=error`, true), [
			DPRINT.command.check,
			`${DPRINT.command.logLevel}=error`,
		]);
	});
});

describe("parseArgs", () => {
	const cases = [
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
	] as const;

	for (const { name, input, expected } of cases) {
		test(`parses ${name}`, () => {
			assert.deepStrictEqual(parseArgs(input), [...expected]);
		});
	}
});

describe("parseCheckAnnotations", () => {
	const cases = [
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
	] as const;

	for (const { name, fixture: fixtureName, expected } of cases) {
		test(`parses ${name} from captured stdout`, () => {
			context.setEnvironment(ENVIRONMENT.githubWorkspace, "/workspace");
			assert.deepStrictEqual(parseCheckAnnotations(fixture("stdout", fixtureName), false), [...expected]);
		});
	}

	test("parses captured list-different stdout", () => {
		context.setEnvironment(ENVIRONMENT.githubWorkspace, "/workspace");
		assert.deepStrictEqual(parseCheckAnnotations(fixture("stdout", "list-different"), true), [
			{ file: "markdown.md" },
			{ file: "powershell.ps1" },
			{ file: "typescript.ts" },
		]);
	});

	for (const name of ["check-debug", "list-different-debug"]) {
		test(`does not parse ${name} stderr as a diff`, () => {
			assert.deepStrictEqual(parseCheckAnnotations(fixture("stderr", name), false), []);
		});
	}

	test("keeps absolute paths outside the workspace", () => {
		context.setEnvironment(ENVIRONMENT.githubWorkspace, "/workspace");
		assert.deepStrictEqual(parseCheckAnnotations(`${resolve("src/first.ts")}\r\nsrc/second.ts\r\n`, true), [
			{ file: resolve("src/first.ts") },
			{ file: "src/second.ts" },
		]);
	});
});

test("runs dprint check with the constructed argv and replays output", async t => {
	const execute = t.mock.fn(async () => ({ stdout: "checked\n", stderr: "detail\n" }));
	const stdout = t.mock.method(process.stdout, "write", () => true);
	const stderr = t.mock.method(process.stderr, "write", () => true);

	await checkFormatting(TEST_DPRINT_BINARY, "config files/dprint.json", "--allow-no-files", { execute });

	assert.strictEqual(execute.mock.callCount(), 1);
	assert.deepStrictEqual(execute.mock.calls[0]?.arguments, [
		TEST_DPRINT_BINARY,
		[DPRINT.command.check, DPRINT.command.config, "config files/dprint.json", "--allow-no-files"],
		{ maxBuffer: 64 * 1024 * 1024 },
	]);
	assert.deepStrictEqual(stdout.mock.calls[0]?.arguments, ["checked\n"]);
	assert.deepStrictEqual(stderr.mock.calls[0]?.arguments, ["detail\n"]);
});

test("checks every explicit configuration", async t => {
	const execute = t.mock.fn(async () => ({}));

	await checkConfigurations(TEST_DPRINT_BINARY, ["first.json", "https://example.com/second.json"], "", { execute });

	assert.strictEqual(execute.mock.callCount(), 2);
	assert.deepStrictEqual(execute.mock.calls[0]?.arguments, [
		TEST_DPRINT_BINARY,
		[DPRINT.command.check, DPRINT.command.config, "first.json"],
		{ maxBuffer: 64 * 1024 * 1024 },
	]);
	assert.deepStrictEqual(execute.mock.calls[1]?.arguments, [
		TEST_DPRINT_BINARY,
		[DPRINT.command.check, DPRINT.command.config, "https://example.com/second.json"],
		{ maxBuffer: 64 * 1024 * 1024 },
	]);
});

test("annotates captured formatting failures from stdout and preserves both output streams", async t => {
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
	const execute = t.mock.fn(async () => Promise.reject(execute.mock.callCount() === 0 ? failure : listFailure));
	const annotate = t.mock.fn(() => {});
	const stdout = t.mock.method(process.stdout, "write", () => true);
	const stderr = t.mock.method(process.stderr, "write", () => true);

	context.setEnvironment(ENVIRONMENT.githubWorkspace, "/workspace");
	await assert.rejects(
		checkFormatting(TEST_DPRINT_BINARY, "", "", { execute, annotate, debug: true }),
		error => error === failure,
	);

	assert.deepStrictEqual(execute.mock.calls[1]?.arguments, [
		TEST_DPRINT_BINARY,
		[DPRINT.command.check, DPRINT.command.logLevel, DPRINT.logLevel.debug, DPRINT.command.listDifferent],
		{ maxBuffer: 64 * 1024 * 1024 },
	]);
	assert.strictEqual(annotate.mock.callCount(), 3);
	assert.deepStrictEqual(annotate.mock.calls[0]?.arguments, ["File is not formatted. Run dprint fmt to fix.", {
		endLine: 6,
		file: "markdown.md",
		line: 3,
		title: "dprint check",
	}]);
	assert.deepStrictEqual(annotate.mock.calls[1]?.arguments, ["File is not formatted. Run dprint fmt to fix.", {
		file: "powershell.ps1",
		line: 1,
		title: "dprint check",
	}]);
	assert.deepStrictEqual(annotate.mock.calls[2]?.arguments, ["File is not formatted. Run dprint fmt to fix.", {
		endLine: 3,
		file: "typescript.ts",
		line: 1,
		title: "dprint check",
	}]);
	assert.strictEqual(isFormattingFailure(failure), true);
	assert.strictEqual(stdout.mock.callCount(), 1);
	assert.deepStrictEqual(stdout.mock.calls[0]?.arguments, [failure.stdout]);
	assert.strictEqual(stderr.mock.callCount(), 1);
	assert.deepStrictEqual(stderr.mock.calls[0]?.arguments, [failure.stderr]);
});

test("does not annotate non-formatting failures", async t => {
	const failure = Object.assign(new Error("invalid configuration"), { code: 1, stderr: "invalid config\n" });
	const execute = t.mock.fn(async () => Promise.reject(failure));
	const annotate = t.mock.fn(() => {});
	t.mock.method(process.stderr, "write", () => true);

	await assert.rejects(
		checkFormatting(TEST_DPRINT_BINARY, "", "", { execute, annotate }),
		error => error === failure,
	);

	assert.strictEqual(execute.mock.callCount(), 1);
	assert.strictEqual(annotate.mock.callCount(), 0);
	assert.strictEqual(isFormattingFailure(failure), false);
});

test("can disable formatting annotations", async t => {
	const failure = Object.assign(new Error("dprint check failed"), {
		code: 20,
		stdout: "from src/example.ts:\n  7|-old\n7  |+new\n--\n",
	});
	const execute = t.mock.fn(async () => Promise.reject(failure));
	const annotate = t.mock.fn(() => {});
	const stdout = t.mock.method(process.stdout, "write", () => true);

	await assert.rejects(
		checkFormatting(TEST_DPRINT_BINARY, "", "", { annotations: false, execute, annotate }),
		error => error === failure,
	);

	assert.strictEqual(execute.mock.callCount(), 1);
	assert.strictEqual(annotate.mock.callCount(), 0);
	assert.strictEqual(isFormattingFailure(failure), true);
	assert.deepStrictEqual(stdout.mock.calls[0]?.arguments, [failure.stdout]);
});
