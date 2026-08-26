import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, test } from "node:test";

import {
	addPath,
	debug,
	error,
	exportVariable,
	getInput,
	getState,
	info,
	isDebug,
	saveState,
	setOutput,
	setSecret,
	warning,
} from "#lib/actions";
import { ACTION_INPUT, ACTION_OUTPUT, ENVIRONMENT } from "#lib/contracts";
import { TEST_DPRINT_BINARY, useTestContext } from "#test/helpers";

const context = useTestContext();

test("reads action inputs with the toolkit's whitespace behavior", () => {
	context.setEnvironment("INPUT_CONFIG-PATH", "  configs/dprint.json  \n");

	assert.strictEqual(getInput(ACTION_INPUT.configPath), "configs/dprint.json");
	assert.strictEqual(getInput(ACTION_INPUT.configPath, { trimWhitespace: false }), "  configs/dprint.json  \n");
	assert.strictEqual(getInput("missing"), "");
});

describe("GitHub file commands", () => {
	test("writes multiline outputs and state without workflow-command escaping", async () => {
		const directory = await context.temporaryDirectory("dprint-actions-");
		const outputFile = join(directory, "output.txt");
		const stateFile = join(directory, "state.txt");
		await writeFile(outputFile, "");
		await writeFile(stateFile, "");
		context.setEnvironment(ENVIRONMENT.githubOutputFile, outputFile);
		context.setEnvironment(ENVIRONMENT.githubStateFile, stateFile);

		setOutput(ACTION_OUTPUT.cacheHit, true);
		setOutput("details", "first\nsecond");
		saveState("cache-key", "dprint\nplugins");

		assert.match(
			await readFile(outputFile, "utf8"),
			/^cache-hit<<dprint_[^\n]+\ntrue\ndprint_[^\n]+\ndetails<<dprint_[^\n]+\nfirst\nsecond\ndprint_[^\n]+\n$/,
		);
		assert.match(
			await readFile(stateFile, "utf8"),
			/^cache-key<<dprint_[^\n]+\ndprint\nplugins\ndprint_[^\n]+\n$/,
		);
	});

	test("exports environment variables and prepends paths", async () => {
		const directory = await context.temporaryDirectory("dprint-actions-");
		const environmentFile = join(directory, "environment.txt");
		const pathFile = join(directory, "path.txt");
		await writeFile(environmentFile, "");
		await writeFile(pathFile, "");
		context.setEnvironment(ENVIRONMENT.githubEnvironmentFile, environmentFile);
		context.setEnvironment(ENVIRONMENT.githubPathFile, pathFile);
		context.setEnvironment(ENVIRONMENT.dprintCacheDirectory, undefined);
		context.setEnvironment("PATH", "/existing/path");

		exportVariable(ENVIRONMENT.dprintCacheDirectory, "/cache/dprint");
		addPath(TEST_DPRINT_BINARY);

		assert.strictEqual(process.env[ENVIRONMENT.dprintCacheDirectory], "/cache/dprint");
		assert.match(
			await readFile(environmentFile, "utf8"),
			new RegExp(
				`^${ENVIRONMENT.dprintCacheDirectory}<<dprint_[^\\n]+\\n/cache/dprint\\ndprint_[^\\n]+\\n$`,
			),
		);
		assert.strictEqual(process.env["PATH"], `${TEST_DPRINT_BINARY}${delimiter}/existing/path`);
		assert.strictEqual(await readFile(pathFile, "utf8"), `${TEST_DPRINT_BINARY}\n`);
	});
});

test("reads action state", () => {
	context.setEnvironment("STATE_CACHE_KEY", "dprint-cache-key");
	assert.strictEqual(getState("CACHE_KEY"), "dprint-cache-key");
});

test("detects runner debug mode", () => {
	context.setEnvironment(ENVIRONMENT.runnerDebug, "1");
	assert.strictEqual(isDebug(), true);
	context.setEnvironment(ENVIRONMENT.runnerDebug, "0");
	assert.strictEqual(isDebug(), false);
});

test("emits escaped workflow commands when file commands are unavailable", t => {
	context.setEnvironment(ENVIRONMENT.githubOutputFile, undefined);
	context.setEnvironment(ENVIRONMENT.githubStateFile, undefined);
	context.setEnvironment(ENVIRONMENT.githubEnvironmentFile, undefined);
	context.setEnvironment(ENVIRONMENT.githubPathFile, undefined);
	context.setEnvironment(ENVIRONMENT.dprintCacheDirectory, undefined);
	context.setEnvironment("PATH", "/existing/path");
	const write = t.mock.method(process.stdout, "write", () => true);

	setSecret("secret%\r\n");
	debug("detail");
	info("plain");
	warning("careful");
	error("bad line\n");
	setOutput("result:,", "line one\nline two");
	saveState("cache-key", "state");
	exportVariable(ENVIRONMENT.dprintCacheDirectory, "/cache");
	addPath("/tools");

	assert.deepStrictEqual(write.mock.calls.map(call => call.arguments[0]), [
		"::add-mask::secret%25%0D%0A\n",
		"::debug::detail\n",
		"plain\n",
		"::warning::careful\n",
		"::error::bad line%0A\n",
		"::set-output name=result%3A%2C::line one%0Aline two\n",
		"::save-state name=cache-key::state\n",
		`::set-env name=${ENVIRONMENT.dprintCacheDirectory}::/cache\n`,
		"::add-path::/tools\n",
	]);
});
