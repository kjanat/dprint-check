import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";

import { findConfigFiles, parseConfigPaths } from "#lib/config";
import { ENVIRONMENT } from "#lib/contracts";
import { useTestContext } from "#test/helpers";

const context = useTestContext();

const workspace = async (): Promise<string> => {
	const path = await context.temporaryDirectory("dprint-check-");
	context.setEnvironment(ENVIRONMENT.githubWorkspace, path);
	return path;
};

test("parses config locators separated by lines, tabs, or pipes", () => {
	assert.deepStrictEqual(
		parseConfigPaths([
			"https://example.com/configs/first.json",
			"https://example.com/configs/with,comma;semicolon.json | configs/*.json\tconfig/local.json",
		].join("\n")),
		[
			"https://example.com/configs/first.json",
			"https://example.com/configs/with,comma;semicolon.json",
			"configs/*.json",
			"config/local.json",
		],
	);
});

describe("findConfigFiles", () => {
	test("prioritizes the root config and includes nested configs", async () => {
		const root = await workspace();
		const nested = join(root, "packages", "example");
		await mkdir(nested, { recursive: true });
		const rootConfig = join(root, ".dprint.jsonc");
		const nestedConfig = join(nested, "dprint.json");
		await writeFile(rootConfig, "{}");
		await writeFile(nestedConfig, "{}");

		assert.deepStrictEqual(await findConfigFiles(), [rootConfig, nestedConfig]);
	});

	test("uses the same root config precedence as dprint", async () => {
		const root = await workspace();
		for (const name of [".dprint.jsonc", ".dprint.json", "dprint.jsonc", "dprint.json"]) {
			await writeFile(join(root, name), "{}");
		}

		assert.strictEqual((await findConfigFiles())[0], join(root, "dprint.json"));
	});

	test("resolves a custom config path from the workspace", async () => {
		const root = await workspace();
		const config = join(root, "config", "ci.json");
		await mkdir(join(root, "config"), { recursive: true });
		await writeFile(config, "{}");
		assert.deepStrictEqual(await findConfigFiles("config/ci.json"), [config]);
	});

	test("expands a config-path glob from the workspace", async () => {
		const root = await workspace();
		const configs = [join(root, "configs", "first.json"), join(root, "configs", "second.json")];
		await mkdir(join(root, "configs"), { recursive: true });
		await Promise.all(configs.map(config => writeFile(config, "{}")));

		assert.deepStrictEqual(await findConfigFiles("configs/*.json"), configs);
	});

	test("accepts a remote config URL", async () => {
		await workspace();
		const url = "https://example.com/configs/dprint.json";

		assert.deepStrictEqual(await findConfigFiles(url), [url]);
	});

	test("expands multiple local and remote config locators", async () => {
		const root = await workspace();
		const localConfigs = [join(root, "configs", "first.json"), join(root, "configs", "second.json")];
		const remoteConfig = "https://example.com/configs/remote.json";
		await mkdir(join(root, "configs"), { recursive: true });
		await Promise.all(localConfigs.map(config => writeFile(config, "{}")));

		assert.deepStrictEqual(await findConfigFiles(`configs/*.json|${remoteConfig}`), [...localConfigs, remoteConfig]);
	});
});
