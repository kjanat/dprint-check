import { env } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeCacheKey, findConfigFiles } from "#lib/config";

env["GITHUB_WORKSPACE"] = undefined;
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
	env["GITHUB_WORKSPACE"] = undefined;
});

async function workspace(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "dprint-check-"));
	temporaryDirectories.push(path);
	env["GITHUB_WORKSPACE"] = path;
	return path;
}

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
		const first = computeCacheKey([config], "0.56.1", "x86_64-unknown-linux-gnu");
		const repeated = computeCacheKey([config], "0.56.1", "x86_64-unknown-linux-gnu");
		expect(repeated).toEqual(first);

		await writeFile(config, "{\"plugins\":[\"json\"]}");
		expect(computeCacheKey([config], "0.56.1", "x86_64-unknown-linux-gnu").primaryKey).not.toBe(
			first.primaryKey,
		);
	});

	test.each(
		[
			"x86_64-unknown-linux-gnu",
			"x86_64-unknown-linux-musl",
		] as const,
	)("scopes restore keys to %s", async platformKey => {
		const root = await workspace();
		const config = join(root, "dprint.json");
		await writeFile(config, "{}");

		const result = computeCacheKey([config], "0.56.1", platformKey);
		const platformPrefix = `dprint-plugins-v2-${platformKey}`;
		expect(result.primaryKey).toStartWith(`${platformPrefix}-0.56.1-`);
		expect(result.restoreKeys).toEqual([`${platformPrefix}-0.56.1-`, `${platformPrefix}-`]);
	});

	test("is independent of config discovery order", async () => {
		const root = await workspace();
		const configs = [join(root, "first.json"), join(root, "second.json")];
		await Promise.all(configs.map((config, index) => writeFile(config, String(index))));

		expect(computeCacheKey(configs, "0.56.1", "x86_64-unknown-linux-gnu")).toEqual(
			computeCacheKey(configs.toReversed(), "0.56.1", "x86_64-unknown-linux-gnu"),
		);
	});
});
