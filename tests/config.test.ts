import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import type { TestContext } from "node:test";

import {
	computeCacheKey,
	findConfigFiles,
	parseConfigPaths,
	prepareConfigRoots,
	resolveConfigGraph,
} from "#lib/config";
import { DPRINT, ENVIRONMENT } from "#lib/contracts";
import { parseRepository } from "#lib/repository";
import { TEST_DPRINT_VERSION, TEST_GNU_PLATFORM, useTestContext } from "#test/helpers";

const context = useTestContext();

const workspace = async (): Promise<string> => {
	const path = await context.temporaryDirectory("dprint-check-");
	context.setEnvironment(ENVIRONMENT.githubWorkspace, path);
	return path;
};

const fetchConfigs = (t: TestContext, configs: Readonly<Record<string, string>>) =>
	t.mock.fn(async (input: string | URL): Promise<Response> => {
		const url = String(input);
		const content = configs[url];
		return content === undefined ? new Response("not found", { status: 404 }) : new Response(content);
	});

const includesMessage = (message: string) => (error: unknown): boolean => String(error).includes(message);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonObject = async (path: string): Promise<Readonly<Record<string, unknown>>> => {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!isRecord(value)) throw new Error(`Expected an object in ${path}`);
	return value;
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
		const names = ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc", "dprint.toml", ".dprint.toml"];
		for (const name of names) {
			await writeFile(join(root, name), name.endsWith(".toml") ? "plugins = []" : "{}");
		}
		for (const name of names) {
			assert.strictEqual((await findConfigFiles())[0], join(root, name));
			await rm(join(root, name));
		}
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

describe("resolveConfigGraph", () => {
	for (const extendsValue of ["\"./base.json\"", "[\"./base.json\"]"]) {
		test(`resolves TOML extends ${extendsValue} through mixed formats`, async () => {
			const root = await workspace();
			const toml = join(root, "dprint.toml");
			const json = join(root, "base.json");
			const child = join(root, "child.toml");
			await writeFile(toml, `extends = ${extendsValue}\nplugins = []`);
			await writeFile(json, "{\"extends\":\"./child.toml\"}");
			await writeFile(child, "[typescript]\nlineWidth = 100");
			const graph = await resolveConfigGraph([toml]);
			assert.deepStrictEqual(graph.sources.map(source => source.source).sort(), [toml, json, child].sort());
			await writeFile(child, "[typescript]\nlineWidth = 120");
			const changed = await resolveConfigGraph([toml]);
			assert.notStrictEqual(
				computeCacheKey(graph, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM).primaryKey,
				computeCacheKey(changed, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM).primaryKey,
			);
		});
	}

	test("detects extensionless TOML and JSONC from their content", async t => {
		await workspace();
		const url = "https://example.com/config";
		for (const content of ["extends = \"./base.toml\"", "/* comment */ {\"extends\":\"./base.toml\"}"]) {
			const graph = await resolveConfigGraph([url], {
				fetch: fetchConfigs(t, { [url]: content, "https://example.com/base.toml": "plugins = []" }),
			});
			assert.strictEqual(graph.sources.length, 2);
		}
	});

	test("parses remote TOML using the final URL pathname after a redirect", async t => {
		await workspace();
		const initial = "https://example.com/config.json";
		const final = "https://example.com/configs/dprint.toml?revision=1";
		const child = "https://example.com/configs/base.json";
		const fetch = t.mock.fn(async (input: string | URL): Promise<Response> => {
			const url = String(input);
			if (url === initial) return new Response(null, { status: 302, headers: { location: final } });
			if (url === final) return new Response("extends = \"./base.json\"\nplugins = []");
			if (url === child) return new Response("{}");
			return new Response("not found", { status: 404 });
		});
		const graph = await resolveConfigGraph([initial], { fetch });
		assert.deepStrictEqual(graph.rootSources, [final]);
		assert.deepStrictEqual(graph.sources.map(source => source.source), [final, child]);
	});

	for (const content of ["plugins = [", "extends = [3]"]) {
		test(`rejects invalid TOML configuration: ${content}`, async () => {
			const root = await workspace();
			const path = join(root, "dprint.toml");
			await writeFile(path, content);
			await assert.rejects(
				resolveConfigGraph([path]),
				includesMessage(
					content === "plugins = [" ? "Failed parsing dprint config" : "Invalid extends",
				),
			);
		});
	}
	test("resolves local and remote extends recursively", async t => {
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
		const fetch = fetchConfigs(t, {
			[remoteConfig]: `{ "extends": "./base.json" }`,
			[remoteBase]: "{}",
		});

		const graph = await resolveConfigGraph([rootConfig], { fetch });

		assert.deepStrictEqual(graph.roots, [rootConfig]);
		assert.strictEqual(graph.hasRemote, true);
		assert.deepStrictEqual(
			graph.sources.map(source => source.source).sort(),
			[rootConfig, localConfig, remoteConfig, remoteBase].sort(),
		);
		assert.strictEqual(fetch.mock.callCount(), 2);
	});

	test("supports a remote root with relative remote extends", async t => {
		await workspace();
		const rootConfig = "https://example.com/team/dprint.json";
		const baseConfig = "https://example.com/shared/base.jsonc";
		const fetch = fetchConfigs(t, {
			[rootConfig]: `{ "extends": "/shared/base.jsonc" }`,
			[baseConfig]: "{}",
		});

		const graph = await resolveConfigGraph([rootConfig], { fetch });

		assert.deepStrictEqual(graph.roots, [rootConfig]);
		assert.deepStrictEqual(graph.sources.map(source => source.source), [rootConfig, baseConfig]);
		assert.strictEqual(graph.sources.every(source => source.remote), true);
	});

	test("follows redirects and resolves relative extends from the final URL", async t => {
		await workspace();
		const requested = "https://example.com/latest.json";
		const redirected = "https://cdn.example.com/configs/dprint.json";
		const base = "https://cdn.example.com/configs/base.json";
		const fetch = t.mock.fn(async (input: string | URL): Promise<Response> => {
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

		assert.deepStrictEqual(graph.roots, [requested]);
		assert.deepStrictEqual(graph.sources.map(source => source.source), [redirected, base]);
		assert.strictEqual(fetch.mock.callCount(), 3);
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

		assert.deepStrictEqual(
			graph.sources.map(source => source.source).sort(),
			[rootConfig, nestedConfig, siblingConfig, sharedConfig].sort(),
		);
	});

	test("rejects circular extends", async () => {
		const root = await workspace();
		const first = join(root, "first.json");
		const second = join(root, "second.json");
		await writeFile(first, `{ "extends": "./second.json" }`);
		await writeFile(second, `{ "extends": "./first.json" }`);

		await assert.rejects(resolveConfigGraph([first]), includesMessage("Circular dprint config extends detected"));
	});

	const rejections = [
		["malformed JSONC", "{", "Failed parsing dprint config"],
		["an unterminated block comment", "{/*", "unterminated block comment"],
		["a non-object config", "[]", "expected an object"],
		["a non-string extends entry", `{ "extends": [1] }`, "expected a string or an array of strings"],
		["an unknown template", `{ "extends": "\${branch}/base.json" }`, "Unknown template literal ${branch}"],
	] as const;

	for (const [name, content, message] of rejections) {
		test(`rejects ${name}`, async () => {
			const root = await workspace();
			const config = join(root, "dprint.json");
			await writeFile(config, content);

			await assert.rejects(resolveConfigGraph([config]), includesMessage(message));
		});
	}

	test("rejects configDir in a remote config", async t => {
		await workspace();
		const remote = "https://example.com/dprint.json";
		const fetch = fetchConfigs(t, { [remote]: `{ "extends": "\${configDir}/base.json" }` });

		await assert.rejects(
			resolveConfigGraph([remote], { fetch }),
			includesMessage("Cannot use ${configDir} in remote dprint config"),
		);
	});

	test("reports a failed remote download", async t => {
		await workspace();
		const remote = "https://example.com/missing.json";

		await assert.rejects(resolveConfigGraph([remote], { fetch: fetchConfigs(t, {}) }), {
			message: `Failed downloading dprint config ${remote}: HTTP 404`,
		});
	});

	test("rejects unsupported config URL protocols", async () => {
		await workspace();

		await assert.rejects(resolveConfigGraph(["ftp://example.com/dprint.json"]), {
			message: "Unsupported config URL protocol: ftp:",
		});
	});
});

describe("computeCacheKey", () => {
	test("isolates repositories in primary and fallback cache keys", async () => {
		const root = await workspace();
		const path = join(root, "dprint.json");
		await writeFile(path, "{}");
		const graph = await resolveConfigGraph([path]);
		const fork = computeCacheKey(graph, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM, parseRepository());
		const upstream = computeCacheKey(graph, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM, parseRepository("dprint/dprint"));
		assert.notStrictEqual(fork.primaryKey, upstream.primaryKey);
		for (const prefix of upstream.restoreKeys) assert.ok(!fork.primaryKey.startsWith(prefix));
		for (const prefix of fork.restoreKeys) assert.ok(!upstream.primaryKey.startsWith(prefix));
	});
	test("is stable and changes with local config contents", async () => {
		const root = await workspace();
		const config = join(root, "dprint.json");
		await writeFile(config, `{"plugins":[]}`);
		const firstGraph = await resolveConfigGraph([config]);
		const first = computeCacheKey(firstGraph, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM);
		const repeated = computeCacheKey(firstGraph, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM);
		assert.deepStrictEqual(repeated, first);

		await writeFile(config, `{"plugins":["json"]}`);
		const changedGraph = await resolveConfigGraph([config]);
		assert.notStrictEqual(
			computeCacheKey(changedGraph, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM).primaryKey,
			first.primaryKey,
		);
	});

	test("changes with inherited remote config contents", async t => {
		const root = await workspace();
		const config = join(root, "dprint.json");
		const remote = "https://example.com/base.json";
		await writeFile(config, `{ "extends": "${remote}" }`);
		const firstGraph = await resolveConfigGraph([config], {
			fetch: fetchConfigs(t, { [remote]: `{"lineWidth":80}` }),
		});
		const changedGraph = await resolveConfigGraph([config], {
			fetch: fetchConfigs(t, { [remote]: `{"lineWidth":120}` }),
		});

		assert.notStrictEqual(
			computeCacheKey(changedGraph, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM).primaryKey,
			computeCacheKey(firstGraph, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM).primaryKey,
		);
	});

	for (const platformKey of [TEST_GNU_PLATFORM, "x86_64-unknown-linux-musl"] as const) {
		test(`scopes restore keys to ${platformKey}`, async () => {
			const root = await workspace();
			const config = join(root, "dprint.json");
			await writeFile(config, "{}");
			const graph = await resolveConfigGraph([config]);

			const result = computeCacheKey(graph, TEST_DPRINT_VERSION, platformKey);
			const platformPrefix = `${DPRINT.name}-plugins-v${DPRINT.pluginCacheVersion}-kjanat_dprint+${platformKey}`;
			assert.ok(result.primaryKey.startsWith(`${platformPrefix}-${TEST_DPRINT_VERSION}-`));
			assert.deepStrictEqual(result.restoreKeys, [`${platformPrefix}-${TEST_DPRINT_VERSION}-`, `${platformPrefix}-`]);
		});
	}

	test("is independent of config discovery order", async () => {
		const root = await workspace();
		const configs = [join(root, "first.json"), join(root, "second.json")];
		await Promise.all(configs.map((config, index) => writeFile(config, `{ "lineWidth": ${80 + index} }`)));
		const forwards = await resolveConfigGraph(configs);
		const backwards = await resolveConfigGraph(configs.toReversed());

		assert.deepStrictEqual(
			computeCacheKey(forwards, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM),
			computeCacheKey(backwards, TEST_DPRINT_VERSION, TEST_GNU_PLATFORM),
		);
	});
});

test("materializes and cleans a remote process-plugin graph in the workspace", async t => {
	const root = await workspace();
	const rootConfig = "https://example.com/configs/dprint.json";
	const processConfig = "https://example.com/configs/process.json";
	const processPlugin = `https://plugins.dprint.dev/exec-0.7.3.json@${"a".repeat(64)}`;
	const graph = await resolveConfigGraph([rootConfig], {
		fetch: fetchConfigs(t, {
			[rootConfig]: `{ "extends": "./process.json" }`,
			[processConfig]: `{ "exec": { "cwd": "\${configDir}" }, "plugins": ["${processPlugin}"] }`,
		}),
	});

	const prepared = await prepareConfigRoots(graph);
	const generatedPaths: string[] = [];
	try {
		assert.strictEqual(prepared.materialized, true);
		assert.strictEqual(prepared.roots.length, 1);
		const preparedRoot = prepared.roots[0];
		if (preparedRoot === undefined) throw new Error("Missing prepared config root");
		generatedPaths.push(preparedRoot);
		assert.strictEqual(dirname(preparedRoot), root);
		const rootContents = await readJsonObject(preparedRoot);
		const rootExtends = rootContents["extends"];
		if (typeof rootExtends !== "string") throw new Error("Missing extends in the prepared config root");
		generatedPaths.push(rootExtends);
		assert.strictEqual(dirname(rootExtends), root);
		assert.deepStrictEqual(rootContents["excludes"], ["**/.dprint-check-*.json"]);
		const processContents = await readJsonObject(rootExtends);
		const exec = processContents["exec"];
		if (!isRecord(exec)) throw new Error("Missing exec in the prepared process config");
		assert.strictEqual(exec["cwd"], "${configDir}");
		assert.deepStrictEqual(processContents["plugins"], [processPlugin]);
		assert.strictEqual(Object.hasOwn(processContents, "excludes"), false);
	} finally {
		await prepared.cleanup();
	}
	for (const path of generatedPaths) assert.strictEqual(existsSync(path), false);
});

test("appends the generated-config exclude to existing root excludes", async t => {
	const root = await workspace();
	const rootConfig = join(root, "dprint.json");
	const remoteConfig = "https://example.com/configs/process.json";
	const processPlugin = `https://plugins.dprint.dev/exec-0.7.3.json@${"a".repeat(64)}`;
	await writeFile(rootConfig, `{ "excludes": ["dist"], "extends": "${remoteConfig}" }`);
	const graph = await resolveConfigGraph([rootConfig], {
		fetch: fetchConfigs(t, { [remoteConfig]: `{ "plugins": ["${processPlugin}"] }` }),
	});

	const prepared = await prepareConfigRoots(graph);
	try {
		assert.strictEqual(prepared.materialized, true);
		const preparedRoot = prepared.roots[0];
		if (preparedRoot === undefined) throw new Error("Missing prepared config root");
		const contents = await readJsonObject(preparedRoot);
		assert.deepStrictEqual(contents["excludes"], ["dist", "**/.dprint-check-*.json"]);
	} finally {
		await prepared.cleanup();
	}
});

test("materializes and cleans remote TOML process-plugin configurations", async t => {
	const root = await workspace();
	const remote = "https://example.com/dprint.toml?revision=1";
	const graph = await resolveConfigGraph([remote], {
		fetch: fetchConfigs(t, {
			[remote]:
				"extends = \"./base.json\"\nplugins = [\"./exec.json\"]\nexcludes = [\"dist\"]\n[typescript]\nlineWidth = 120\n[exec]\ncwd = \"${configDir}\"\n[[exec.commands]]\ncommand = \"test\"",
			"https://example.com/base.json": "{\"lineWidth\":100}",
		}),
	});
	const prepared = await prepareConfigRoots(graph);
	const generated: string[] = [];
	try {
		assert.strictEqual(prepared.materialized, true);
		const preparedRoot = prepared.roots[0];
		assert.ok(preparedRoot !== undefined);
		generated.push(preparedRoot);
		assert.strictEqual(dirname(preparedRoot), root);
		const contents = await readJsonObject(preparedRoot);
		assert.deepStrictEqual(contents["plugins"], ["https://example.com/exec.json"]);
		assert.deepStrictEqual(contents["typescript"], { lineWidth: 120 });
		assert.deepStrictEqual(contents["exec"], { cwd: "${configDir}", commands: [{ command: "test" }] });
		assert.deepStrictEqual(contents["excludes"], ["dist", "**/.dprint-check-*.json"]);
		const inherited = contents["extends"];
		assert.ok(typeof inherited === "string");
		generated.push(inherited);
		assert.deepStrictEqual(await readJsonObject(inherited), { lineWidth: 100 });
	} finally {
		await prepared.cleanup();
	}
	for (const path of generated) assert.strictEqual(existsSync(path), false);
});
