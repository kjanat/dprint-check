import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCacheKey, findConfigFiles } from "../src/config.ts";

const originalWorkspace = process.env["GITHUB_WORKSPACE"];
const temporaryDirectories: string[] = [];

afterEach(async () => {
	if (originalWorkspace === undefined) delete process.env["GITHUB_WORKSPACE"];
	else process.env["GITHUB_WORKSPACE"] = originalWorkspace;
	await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "dprint-check-"));
	temporaryDirectories.push(path);
	process.env["GITHUB_WORKSPACE"] = path;
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

	test("resolves a custom config path from the workspace", async () => {
		const root = await workspace();
		const config = join(root, "config", "ci.json");
		await mkdir(join(root, "config"), { recursive: true });
		await writeFile(config, "{}");
		expect(await findConfigFiles("config/ci.json")).toEqual([config]);
	});
});

describe("computeCacheKey", () => {
	test("is stable and changes with config contents", async () => {
		const root = await workspace();
		const config = join(root, "dprint.json");
		await writeFile(config, "{\"plugins\":[]}");
		const first = computeCacheKey([config], "0.56.1");
		const repeated = computeCacheKey([config], "0.56.1");
		expect(repeated).toEqual(first);
		expect(first.primaryKey).toContain("dprint-plugins-v1-");

		await writeFile(config, "{\"plugins\":[\"json\"]}");
		expect(computeCacheKey([config], "0.56.1").primaryKey).not.toBe(first.primaryKey);
	});
});
