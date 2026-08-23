import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { computeCacheKey, findConfigFiles } from "#lib/config";
import { DPRINT, ENVIRONMENT } from "#lib/contracts";
import { TEST_DPRINT_VERSION, TEST_GNU_PLATFORM, useTestContext } from "#test/helpers";

const context = useTestContext();

const workspace = async (): Promise<string> => {
	const path = await context.temporaryDirectory("dprint-check-");
	context.setEnvironment(ENVIRONMENT.githubWorkspace, path);
	return path;
};

describe("findConfigFiles", () => {
	test("prioritizes the root config and includes nested configs", async () => {
		const root = await workspace();
		const nested = join(root, "packages", "example");
		await mkdir(nested, { recursive: true });
		const rootConfig = join(root, ".dprint.jsonc");
		const nestedConfig = join(nested, "dprint.json");
		await writeFile(rootConfig, "{}");
		await writeFile(nestedConfig, "{}");

		expect(await findConfigFiles()).toEqual([rootConfig, nestedConfig]);
	});

	test("uses the same root config precedence as dprint", async () => {
		const root = await workspace();
		for (const name of [".dprint.jsonc", ".dprint.json", "dprint.jsonc", "dprint.json"]) {
			await writeFile(join(root, name), "{}");
		}

		expect((await findConfigFiles())[0]).toBe(join(root, "dprint.json"));
	});

	test("resolves a custom config path from the workspace", async () => {
		const root = await workspace();
		const config = join(root, "config", "ci.json");
		await mkdir(join(root, "config"), { recursive: true });
		await writeFile(config, "{}");
		expect(await findConfigFiles("config/ci.json")).toEqual([config]);
	});

	test("expands a config-path glob from the workspace", async () => {
		const root = await workspace();
		const configs = [join(root, "configs", "first.json"), join(root, "configs", "second.json")];
		await mkdir(join(root, "configs"), { recursive: true });
		await Promise.all(configs.map(config => writeFile(config, "{}")));

		expect(await findConfigFiles("configs/*.json")).toEqual(configs);
	});
});

describe("computeCacheKey", () => {
	test("is stable and changes with config contents", async () => {
		const root = await workspace();
		const config = join(root, "dprint.json");
		await writeFile(config, "{\"plugins\":[]}");
		const first = computeCacheKey([config], TEST_DPRINT_VERSION, TEST_GNU_PLATFORM);
		const repeated = computeCacheKey([config], TEST_DPRINT_VERSION, TEST_GNU_PLATFORM);
		expect(repeated).toEqual(first);

		await writeFile(config, "{\"plugins\":[\"json\"]}");
		expect(computeCacheKey([config], TEST_DPRINT_VERSION, TEST_GNU_PLATFORM).primaryKey).not.toBe(
			first.primaryKey,
		);
	});

	test.each(
		[
			TEST_GNU_PLATFORM,
			"x86_64-unknown-linux-musl",
		] as const,
	)("scopes restore keys to %s", async platformKey => {
		const root = await workspace();
		const config = join(root, "dprint.json");
		await writeFile(config, "{}");

		const result = computeCacheKey([config], TEST_DPRINT_VERSION, platformKey);
		const platformPrefix = `${DPRINT.name}-plugins-v${DPRINT.pluginCacheVersion}-${platformKey}`;
		expect(result.primaryKey).toStartWith(`${platformPrefix}-${TEST_DPRINT_VERSION}-`);
		expect(result.restoreKeys).toEqual([
			`${platformPrefix}-${TEST_DPRINT_VERSION}-`,
			`${platformPrefix}-`,
		]);
	});

	test("is independent of config discovery order", async () => {
		const root = await workspace();
		const configs = [join(root, "first.json"), join(root, "second.json")];
		await Promise.all(configs.map((config, index) => writeFile(config, String(index))));

		expect(computeCacheKey(configs, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM)).toEqual(
			computeCacheKey(configs.toReversed(), TEST_DPRINT_VERSION, TEST_GNU_PLATFORM),
		);
	});
});
