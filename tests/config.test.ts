import { describe, expect, mock, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
	computeCacheKey,
	findConfigFiles,
	parseConfigPaths,
	prepareConfigRoots,
	resolveConfigGraph,
} from "#lib/config";
import { DPRINT, ENVIRONMENT } from "#lib/contracts";
import { TEST_DPRINT_VERSION, TEST_GNU_PLATFORM, useTestContext } from "#test/helpers";

const context = useTestContext();

const workspace = async (): Promise<string> => {
	const path = await context.temporaryDirectory("dprint-check-");
	context.setEnvironment(ENVIRONMENT.githubWorkspace, path);
	return path;
};

const fetchConfigs = (configs: Readonly<Record<string, string>>) =>
	mock(async (input: string | URL): Promise<Response> => {
		const url = String(input);
		const content = configs[url];
		return content === undefined ? new Response("not found", { status: 404 }) : new Response(content);
	});

test("parses config locators separated by lines, tabs, or pipes", () => {
	expect(parseConfigPaths([
		"https://example.com/configs/first.json",
		"https://example.com/configs/with,comma;semicolon.json | configs/*.json\tconfig/local.json",
	].join("\n"))).toEqual([
		"https://example.com/configs/first.json",
		"https://example.com/configs/with,comma;semicolon.json",
		"configs/*.json",
		"config/local.json",
	]);
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

	test("accepts a remote config URL", async () => {
		await workspace();
		const url = "https://example.com/configs/dprint.json";

		expect(await findConfigFiles(url)).toEqual([url]);
	});

	test("expands multiple local and remote config locators", async () => {
		const root = await workspace();
		const localConfigs = [join(root, "configs", "first.json"), join(root, "configs", "second.json")];
		const remoteConfig = "https://example.com/configs/remote.json";
		await mkdir(join(root, "configs"), { recursive: true });
		await Promise.all(localConfigs.map(config => writeFile(config, "{}")));

		expect(await findConfigFiles(`configs/*.json|${remoteConfig}`)).toEqual([...localConfigs, remoteConfig]);
	});
});

describe("resolveConfigGraph", () => {
	test("resolves local and remote extends recursively", async () => {
		const root = await workspace();
		const rootConfig = join(root, "dprint.jsonc");
		const localConfig = join(root, "base.json");
		const remoteConfig = "https://example.com/configs/remote.jsonc";
		const remoteBase = "https://example.com/configs/base.json";
		await writeFile(
			rootConfig,
			`{
				"schema": "https://example.com/schema.json",
				"extends": [
					"./base.json",
					/* Remote references are part of the same graph. */
					"${remoteConfig}",
				],
			}`,
		);
		await writeFile(localConfig, "{}");
		const fetch = fetchConfigs({
			[remoteConfig]: `{ "extends": "./base.json" }`,
			[remoteBase]: "{}",
		});

		const graph = await resolveConfigGraph([rootConfig], { fetch });

		expect(graph.roots).toEqual([rootConfig]);
		expect(graph.hasRemote).toBeTrue();
		expect(graph.sources.map(source => source.source).sort()).toEqual(
			[rootConfig, localConfig, remoteConfig, remoteBase].sort(),
		);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("supports a remote root with relative remote extends", async () => {
		await workspace();
		const rootConfig = "https://example.com/team/dprint.json";
		const baseConfig = "https://example.com/shared/base.jsonc";
		const fetch = fetchConfigs({
			[rootConfig]: `{ "extends": "/shared/base.jsonc" }`,
			[baseConfig]: "{}",
		});

		const graph = await resolveConfigGraph([rootConfig], { fetch });

		expect(graph.roots).toEqual([rootConfig]);
		expect(graph.sources.map(source => source.source)).toEqual([rootConfig, baseConfig]);
		expect(graph.sources.every(source => source.remote)).toBeTrue();
	});

	test("follows redirects and resolves relative extends from the final URL", async () => {
		await workspace();
		const requested = "https://example.com/latest.json";
		const redirected = "https://cdn.example.com/configs/dprint.json";
		const base = "https://cdn.example.com/configs/base.json";
		const fetch = mock(async (input: string | URL): Promise<Response> => {
			switch (String(input)) {
				case requested:
					return new Response(null, { status: 302, headers: { location: redirected } });
				case redirected:
					return new Response(`{ "extends": "./base.json" }`);
				case base:
					return new Response("{}");
				default:
					return new Response("not found", { status: 404 });
			}
		});

		const graph = await resolveConfigGraph([requested], { fetch });

		expect(graph.roots).toEqual([requested]);
		expect(graph.sources.map(source => source.source)).toEqual([redirected, base]);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	test("expands local configDir and originConfigDir references", async () => {
		const root = await workspace();
		const rootConfig = join(root, "dprint.json");
		const nestedConfig = join(root, "configs", "nested.json");
		const siblingConfig = join(root, "configs", "sibling.json");
		const sharedConfig = join(root, "shared.json");
		await mkdir(join(root, "configs"), { recursive: true });
		await writeFile(rootConfig, `{ "extends": "./configs/nested.json" }`);
		await writeFile(
			nestedConfig,
			`{ "extends": ["\${configDir}/sibling.json", "\${originConfigDir}/shared.json"] }`,
		);
		await writeFile(siblingConfig, "{}");
		await writeFile(sharedConfig, "{}");

		const graph = await resolveConfigGraph([rootConfig]);

		expect(graph.sources.map(source => source.source).sort()).toEqual(
			[rootConfig, nestedConfig, siblingConfig, sharedConfig].sort(),
		);
	});

	test("rejects circular extends", async () => {
		const root = await workspace();
		const first = join(root, "first.json");
		const second = join(root, "second.json");
		await writeFile(first, `{ "extends": "./second.json" }`);
		await writeFile(second, `{ "extends": "./first.json" }`);

		expect(resolveConfigGraph([first])).rejects.toThrow("Circular dprint config extends detected");
	});

	test.each(
		[
			["malformed JSONC", "{", "Failed parsing dprint config"],
			["an unterminated block comment", "{/*", "unterminated block comment"],
			["a non-object config", "[]", "expected an object"],
			["a non-string extends entry", `{ "extends": [1] }`, "expected a string or an array of strings"],
			["an unknown template", `{ "extends": "\${branch}/base.json" }`, "Unknown template literal ${branch}"],
		] as const,
	)("rejects %s", async (_name, content, message) => {
		const root = await workspace();
		const config = join(root, "dprint.json");
		await writeFile(config, content);

		expect(resolveConfigGraph([config])).rejects.toThrow(message);
	});

	test("rejects configDir in a remote config", async () => {
		await workspace();
		const remote = "https://example.com/dprint.json";
		const fetch = fetchConfigs({ [remote]: `{ "extends": "\${configDir}/base.json" }` });

		expect(resolveConfigGraph([remote], { fetch })).rejects.toThrow("Cannot use ${configDir} in remote dprint config");
	});

	test("reports a failed remote download", async () => {
		await workspace();
		const remote = "https://example.com/missing.json";

		expect(resolveConfigGraph([remote], { fetch: fetchConfigs({}) })).rejects.toThrow(
			`Failed downloading dprint config ${remote}: HTTP 404`,
		);
	});

	test("rejects unsupported config URL protocols", async () => {
		await workspace();

		expect(resolveConfigGraph(["ftp://example.com/dprint.json"])).rejects.toThrow(
			"Unsupported config URL protocol: ftp:",
		);
	});
});

describe("computeCacheKey", () => {
	test("is stable and changes with local config contents", async () => {
		const root = await workspace();
		const config = join(root, "dprint.json");
		await writeFile(config, `{"plugins":[]}`);
		const firstGraph = await resolveConfigGraph([config]);
		const first = computeCacheKey(firstGraph, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM);
		const repeated = computeCacheKey(firstGraph, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM);
		expect(repeated).toEqual(first);

		await writeFile(config, `{"plugins":["json"]}`);
		const changedGraph = await resolveConfigGraph([config]);
		expect(computeCacheKey(changedGraph, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM).primaryKey).not.toBe(
			first.primaryKey,
		);
	});

	test("changes with inherited remote config contents", async () => {
		const root = await workspace();
		const config = join(root, "dprint.json");
		const remote = "https://example.com/base.json";
		await writeFile(config, `{ "extends": "${remote}" }`);
		const firstGraph = await resolveConfigGraph([config], { fetch: fetchConfigs({ [remote]: `{"lineWidth":80}` }) });
		const changedGraph = await resolveConfigGraph([config], {
			fetch: fetchConfigs({ [remote]: `{"lineWidth":120}` }),
		});

		expect(computeCacheKey(changedGraph, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM).primaryKey).not.toBe(
			computeCacheKey(firstGraph, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM).primaryKey,
		);
	});

	test.each([TEST_GNU_PLATFORM, "x86_64-unknown-linux-musl"] as const)(
		"scopes restore keys to %s",
		async platformKey => {
			const root = await workspace();
			const config = join(root, "dprint.json");
			await writeFile(config, "{}");
			const graph = await resolveConfigGraph([config]);

			const result = computeCacheKey(graph, TEST_DPRINT_VERSION, platformKey);
			const platformPrefix = `${DPRINT.name}-plugins-v${DPRINT.pluginCacheVersion}-${platformKey}`;
			expect(result.primaryKey).toStartWith(`${platformPrefix}-${TEST_DPRINT_VERSION}-`);
			expect(result.restoreKeys).toEqual([`${platformPrefix}-${TEST_DPRINT_VERSION}-`, `${platformPrefix}-`]);
		},
	);

	test("is independent of config discovery order", async () => {
		const root = await workspace();
		const configs = [join(root, "first.json"), join(root, "second.json")];
		await Promise.all(configs.map((config, index) => writeFile(config, `{ "lineWidth": ${80 + index} }`)));
		const forwards = await resolveConfigGraph(configs);
		const backwards = await resolveConfigGraph(configs.toReversed());

		expect(computeCacheKey(forwards, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM)).toEqual(
			computeCacheKey(backwards, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM),
		);
	});
});

test("materializes and cleans a remote process-plugin graph in the workspace", async () => {
	const root = await workspace();
	const rootConfig = "https://example.com/configs/dprint.json";
	const processConfig = "https://example.com/configs/process.json";
	const processPlugin = `https://plugins.dprint.dev/exec-0.7.3.json@${"a".repeat(64)}`;
	const graph = await resolveConfigGraph([rootConfig], {
		fetch: fetchConfigs({
			[rootConfig]: `{ "extends": "./process.json" }`,
			[processConfig]: `{ "exec": { "cwd": "\${configDir}" }, "plugins": ["${processPlugin}"] }`,
		}),
	});

	const prepared = await prepareConfigRoots(graph);
	const generatedPaths: string[] = [];
	try {
		expect(prepared.materialized).toBeTrue();
		expect(prepared.roots).toHaveLength(1);
		const preparedRoot = prepared.roots[0];
		expect(preparedRoot).toBeString();
		if (preparedRoot === undefined) throw new Error("Missing prepared config root");
		generatedPaths.push(preparedRoot);
		expect(dirname(preparedRoot)).toBe(root);
		const rootContents = JSON.parse(await readFile(preparedRoot, "utf8")) as { extends: string };
		generatedPaths.push(rootContents.extends);
		expect(dirname(rootContents.extends)).toBe(root);
		const processContents = JSON.parse(await readFile(rootContents.extends, "utf8")) as {
			exec: { cwd: string };
			plugins: string[];
		};
		expect(processContents.exec.cwd).toBe("${configDir}");
		expect(processContents.plugins).toEqual([processPlugin]);
	} finally {
		await prepared.cleanup();
	}
	for (const path of generatedPaths) expect(await Bun.file(path).exists()).toBeFalse();
});
