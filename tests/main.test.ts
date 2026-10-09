import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import * as actions from "#lib/actions";
import * as cache from "#lib/cache";
import { ACTION_INPUT, ENVIRONMENT } from "#lib/contracts";
import { PLUGIN_CACHE_ENVIRONMENT } from "#lib/repository";
import { useTestContext } from "#test/helpers";

const context = useTestContext();

test("main controls plugin and binary cache operations independently", async t => {
	const root = await context.temporaryDirectory("dprint-check-main-");
	for (const name of [ENVIRONMENT.dprintCacheDirectory, PLUGIN_CACHE_ENVIRONMENT.root, PLUGIN_CACHE_ENVIRONMENT.path]) {
		context.setEnvironment(name, undefined);
	}
	context.setEnvironment(ENVIRONMENT.dprintCacheDirectory, join(root, "plugins"));
	const configPath = join(root, "dprint.toml");
	await writeFile(configPath, "plugins = []");
	const inputs: Record<string, string> = {
		[ACTION_INPUT.installOnly]: "true",
		[ACTION_INPUT.cache]: "false",
		[ACTION_INPUT.configPath]: configPath,
	};
	const installations: boolean[] = [];
	const restores: string[] = [];
	const warmups: string[] = [];
	const actionsMock = {
		cache: false,
		exports: {
			...actions,
			getInput: (name: string) => inputs[name] ?? "",
			info: () => {},
			debug: () => {},
			exportVariable: (name: string, value: string) => {
				process.env[name] = value;
			},
			saveState: () => {},
			setOutput: () => {},
			setFailed: (message: string) => {
				throw new Error(message);
			},
		},
	};
	t.mock.module("#lib/actions", actionsMock);
	const cacheMock = {
		cache: false,
		exports: {
			...cache,
			isCacheAvailable: () => true,
			restoreCache: async (_paths: string[], key: string) => {
				restores.push(key);
				return undefined;
			},
		},
	};
	t.mock.module("#lib/cache", cacheMock);
	const installMock = {
		cache: false,
		exports: {
			installDprint: async (_version: string, binaryCache: boolean) => {
				installations.push(binaryCache);
				return { version: "0.56.1", location: join(root, "dprint"), platformKey: "test-platform", cacheHit: false };
			},
		},
	};
	t.mock.module("#lib/install", installMock);
	const warmupMock = {
		cache: false,
		exports: {
			warmupPlugins: async (path: string) => {
				warmups.push(path);
				return true;
			},
		},
	};
	t.mock.module("#lib/warmup", warmupMock);
	const { run } = await import("#main");
	await run(); // Drain the entrypoint's automatic invocation before checking each case.
	for (
		const { plugin, binary, expectedPlugin, expectedBinary } of [
			{ plugin: "", binary: "", expectedPlugin: true, expectedBinary: false },
			{ plugin: "true", binary: "false", expectedPlugin: true, expectedBinary: false },
			{ plugin: "false", binary: "false", expectedPlugin: false, expectedBinary: false },
			{ plugin: "false", binary: "true", expectedPlugin: false, expectedBinary: true },
			{ plugin: "true", binary: "true", expectedPlugin: true, expectedBinary: true },
		]
	) {
		inputs[ACTION_INPUT.cache] = plugin;
		inputs[ACTION_INPUT.cacheBinary] = binary;
		installations.length = 0;
		restores.length = 0;
		warmups.length = 0;
		await run();
		assert.deepStrictEqual(installations, [expectedBinary]);
		assert.strictEqual(restores.length, expectedPlugin ? 1 : 0);
		assert.strictEqual(warmups.length, expectedPlugin ? 1 : 0);
	}
});
