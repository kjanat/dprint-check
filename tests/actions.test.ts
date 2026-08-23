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
import { useTestContext } from "#test/helpers";

const context = useTestContext();

test("reads action inputs with the toolkit's whitespace behavior", () => {
	context.setEnvironment("INPUT_CONFIG-PATH", "  configs/dprint.json  \n");

	expect(getInput("config-path")).toBe("configs/dprint.json");
	expect(getInput("config-path", { trimWhitespace: false })).toBe("  configs/dprint.json  \n");
	expect(getInput("missing")).toBe("");
});

describe("GitHub file commands", () => {
	test("writes multiline outputs and state without workflow-command escaping", async () => {
		const directory = await context.temporaryDirectory("dprint-actions-");
		const outputFile = join(directory, "output.txt");
		const stateFile = join(directory, "state.txt");
		await writeFile(outputFile, "");
		await writeFile(stateFile, "");
		context.setEnvironment("GITHUB_OUTPUT", outputFile);
		context.setEnvironment("GITHUB_STATE", stateFile);

		setOutput("cache-hit", true);
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
		context.setEnvironment("GITHUB_ENV", environmentFile);
		context.setEnvironment("GITHUB_PATH", pathFile);
		context.setEnvironment("DPRINT_CACHE_DIR", undefined);
		context.setEnvironment("PATH", "/existing/path");

		exportVariable("DPRINT_CACHE_DIR", "/cache/dprint");
		addPath("/tools/dprint");

		expect(process.env["DPRINT_CACHE_DIR"]).toBe("/cache/dprint");
		expect(await readFile(environmentFile, "utf8")).toMatch(
			/^DPRINT_CACHE_DIR<<dprint_[^\n]+\n\/cache\/dprint\ndprint_[^\n]+\n$/,
		);
		expect(process.env["PATH"]).toBe(`/tools/dprint${delimiter}/existing/path`);
		expect(await readFile(pathFile, "utf8")).toBe("/tools/dprint\n");
	});
});

test("reads action state", () => {
	context.setEnvironment("STATE_CACHE_KEY", "dprint-cache-key");
	expect(getState("CACHE_KEY")).toBe("dprint-cache-key");
});

test("emits escaped workflow commands when file commands are unavailable", () => {
	context.setEnvironment("GITHUB_OUTPUT", undefined);
	context.setEnvironment("GITHUB_STATE", undefined);
	context.setEnvironment("GITHUB_ENV", undefined);
	context.setEnvironment("GITHUB_PATH", undefined);
	context.setEnvironment("DPRINT_CACHE_DIR", undefined);
	context.setEnvironment("PATH", "/existing/path");
	const write = spyOn(process.stdout, "write").mockImplementation(() => true);
	try {
		setSecret("secret%\r\n");
		debug("detail");
		info("plain");
		warning("careful");
		setOutput("result:,", "line one\nline two");
		saveState("cache-key", "state");
		exportVariable("DPRINT_CACHE_DIR", "/cache");
		addPath("/tools");

		expect(write.mock.calls.map(([message]) => message)).toEqual([
			"::add-mask::secret%25%0D%0A\n",
			"::debug::detail\n",
			"plain\n",
			"::warning::careful\n",
			"::set-output name=result%3A%2C::line one%0Aline two\n",
			"::save-state name=cache-key::state\n",
			"::set-env name=DPRINT_CACHE_DIR::/cache\n",
			"::add-path::/tools\n",
		]);
	} finally {
		write.mockRestore();
	}
});
