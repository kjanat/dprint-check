import assert from "node:assert/strict";
import { test } from "node:test";

import { DPRINT, ENVIRONMENT } from "#lib/contracts";
import { WARMUP_ATTEMPTS, WARMUP_MAX_BUFFER, WARMUP_TIMEOUT_MS, warmupPlugins } from "#lib/warmup";
import { TEST_DPRINT_BINARY, useTestContext } from "#test/helpers";

const context = useTestContext();

test("warms every discovered config sequentially", async t => {
	const configs = ["/workspace/dprint.json", "/workspace/packages/example/dprint.jsonc"];
	let active = 0;
	let maximumActive = 0;
	const execute = t.mock.fn(async () => {
		active++;
		maximumActive = Math.max(maximumActive, active);
		await Promise.resolve();
		active--;
	});

	assert.strictEqual(await warmupPlugins(TEST_DPRINT_BINARY, configs, { execute }), true);
	assert.strictEqual(maximumActive, 1);
	assert.deepStrictEqual(execute.mock.calls[0]?.arguments, [
		TEST_DPRINT_BINARY,
		[DPRINT.command.warmup, DPRINT.command.config, configs[0]],
		{
			timeout: WARMUP_TIMEOUT_MS,
			cwd: "/workspace",
			maxBuffer: WARMUP_MAX_BUFFER,
		},
	]);
	assert.deepStrictEqual(execute.mock.calls[1]?.arguments, [
		TEST_DPRINT_BINARY,
		[DPRINT.command.warmup, DPRINT.command.config, configs[1]],
		{
			timeout: WARMUP_TIMEOUT_MS,
			cwd: "/workspace/packages/example",
			maxBuffer: WARMUP_MAX_BUFFER,
		},
	]);
});

test("does nothing when no configs are discovered", async t => {
	const execute = t.mock.fn(async () => {});

	assert.strictEqual(await warmupPlugins(TEST_DPRINT_BINARY, [], { execute }), true);
	assert.strictEqual(execute.mock.callCount(), 0);
});

test("warms a remote config from the workspace", async t => {
	const workspace = "/workspace";
	const config = "https://example.com/configs/dprint.json";
	context.setEnvironment(ENVIRONMENT.githubWorkspace, workspace);
	const execute = t.mock.fn(async () => {});

	assert.strictEqual(await warmupPlugins(TEST_DPRINT_BINARY, [config], { execute }), true);
	assert.deepStrictEqual(execute.mock.calls[0]?.arguments, [
		TEST_DPRINT_BINARY,
		[DPRINT.command.warmup, DPRINT.command.config, config],
		{
			timeout: WARMUP_TIMEOUT_MS,
			cwd: workspace,
			maxBuffer: WARMUP_MAX_BUFFER,
		},
	]);
});

test("stops after a non-timeout warmup failure", async t => {
	const execute = t.mock.fn(async () => {
		throw new Error("invalid config");
	});
	const stdout = t.mock.method(process.stdout, "write", () => true);

	assert.strictEqual(await warmupPlugins(TEST_DPRINT_BINARY, ["one.json", "two.json"], { execute }), false);
	assert.strictEqual(execute.mock.callCount(), 1);
	assert.deepStrictEqual(stdout.mock.calls[0]?.arguments, ["::warning::Plugin warmup failed: invalid config\n"]);
});

test(`retries a hung warmup ${WARMUP_ATTEMPTS} times, then continues without saving`, async t => {
	const execute = t.mock.fn(async () => {
		throw Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
	});
	const stdout = t.mock.method(process.stdout, "write", () => true);

	assert.strictEqual(await warmupPlugins(TEST_DPRINT_BINARY, ["dprint.json"], { execute }), false);
	assert.strictEqual(execute.mock.callCount(), WARMUP_ATTEMPTS);
	assert.deepStrictEqual(stdout.mock.calls[WARMUP_ATTEMPTS]?.arguments, [
		`::warning::Plugin warmup kept hanging after ${WARMUP_ATTEMPTS} attempts; continuing without saving the plugin cache\n`,
	]);
});

test("enables dprint debug logging during plugin warmup", async t => {
	const execute = t.mock.fn(async (_binary: string, _args: string[], _options: object) => {});

	assert.strictEqual(await warmupPlugins(TEST_DPRINT_BINARY, ["dprint.json"], { debug: true, execute }), true);
	const call = execute.mock.calls[0]?.arguments;
	assert.strictEqual(call?.[0], TEST_DPRINT_BINARY);
	assert.deepStrictEqual(call?.[1], [
		DPRINT.command.warmup,
		DPRINT.command.config,
		"dprint.json",
		DPRINT.command.logLevel,
		DPRINT.logLevel.debug,
	]);
	assert.strictEqual(typeof call?.[2], "object");
});
