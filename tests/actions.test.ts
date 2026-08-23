import { describe, expect, spyOn, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import {
	addPath,
	debug,
	exportVariable,
	getInput,
	getState,
	info,
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

	expect(getInput(ACTION_INPUT.configPath)).toBe("configs/dprint.json");
	expect(getInput(ACTION_INPUT.configPath, { trimWhitespace: false })).toBe("  configs/dprint.json  \n");
	expect(getInput("missing")).toBe("");
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

		expect(await readFile(outputFile, "utf8")).toMatch(
			/^cache-hit<<dprint_[^\n]+\ntrue\ndprint_[^\n]+\ndetails<<dprint_[^\n]+\nfirst\nsecond\ndprint_[^\n]+\n$/,
		);
		expect(await readFile(stateFile, "utf8")).toMatch(
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

		expect(process.env[ENVIRONMENT.dprintCacheDirectory]).toBe("/cache/dprint");
		expect(await readFile(environmentFile, "utf8")).toMatch(
			new RegExp(
				`^${ENVIRONMENT.dprintCacheDirectory}<<dprint_[^\\n]+\\n/cache/dprint\\ndprint_[^\\n]+\\n$`,
			),
		);
		expect(process.env["PATH"]).toBe(`${TEST_DPRINT_BINARY}${delimiter}/existing/path`);
		expect(await readFile(pathFile, "utf8")).toBe(`${TEST_DPRINT_BINARY}\n`);
	});
});

test("reads action state", () => {
	context.setEnvironment("STATE_CACHE_KEY", "dprint-cache-key");
	expect(getState("CACHE_KEY")).toBe("dprint-cache-key");
});

test("emits escaped workflow commands when file commands are unavailable", () => {
	context.setEnvironment(ENVIRONMENT.githubOutputFile, undefined);
	context.setEnvironment(ENVIRONMENT.githubStateFile, undefined);
	context.setEnvironment(ENVIRONMENT.githubEnvironmentFile, undefined);
	context.setEnvironment(ENVIRONMENT.githubPathFile, undefined);
	context.setEnvironment(ENVIRONMENT.dprintCacheDirectory, undefined);
	context.setEnvironment("PATH", "/existing/path");
	const write = spyOn(process.stdout, "write").mockImplementation(() => true);
	try {
		setSecret("secret%\r\n");
		debug("detail");
		info("plain");
		warning("careful");
		setOutput("result:,", "line one\nline two");
		saveState("cache-key", "state");
		exportVariable(ENVIRONMENT.dprintCacheDirectory, "/cache");
		addPath("/tools");

		expect(write.mock.calls.map(([message]) => message)).toEqual([
			"::add-mask::secret%25%0D%0A\n",
			"::debug::detail\n",
			"plain\n",
			"::warning::careful\n",
			"::set-output name=result%3A%2C::line one%0Aline two\n",
			"::save-state name=cache-key::state\n",
			`::set-env name=${ENVIRONMENT.dprintCacheDirectory}::/cache\n`,
			"::add-path::/tools\n",
		]);
	} finally {
		write.mockRestore();
	}
});
