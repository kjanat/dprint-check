import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildCheckArgs, checkConfigurations, checkFormatting, isFormattingFailure, parseArgs } from "#lib/check";
import { DPRINT } from "#lib/contracts";
import { TEST_DPRINT_BINARY } from "#test/helpers";

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

test("marks captured formatting failures and preserves their output", async t => {
	const failure = Object.assign(new Error("dprint check failed"), {
		code: 20,
		stdout: "from src/example.ts:\n  7|-old\n7  |+new\n--\n",
	});
	const execute = t.mock.fn(async () => Promise.reject(failure));
	const stdout = t.mock.method(process.stdout, "write", () => true);

	await assert.rejects(checkFormatting(TEST_DPRINT_BINARY, "", "", { execute }), error => error === failure);

	assert.strictEqual(execute.mock.callCount(), 1);
	assert.strictEqual(isFormattingFailure(failure), true);
	assert.deepStrictEqual(stdout.mock.calls[0]?.arguments, [failure.stdout]);
});

test("does not mark non-formatting failures", async t => {
	const failure = Object.assign(new Error("invalid configuration"), { code: 1, stderr: "invalid config\n" });
	const execute = t.mock.fn(async () => Promise.reject(failure));
	const stderr = t.mock.method(process.stderr, "write", () => true);

	await assert.rejects(checkFormatting(TEST_DPRINT_BINARY, "", "", { execute }), error => error === failure);

	assert.strictEqual(execute.mock.callCount(), 1);
	assert.strictEqual(isFormattingFailure(failure), false);
	assert.deepStrictEqual(stderr.mock.calls[0]?.arguments, [failure.stderr]);
});
