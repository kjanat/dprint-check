import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";

import { parseRepository, PLUGIN_CACHE_ENVIRONMENT, resolvePluginCacheDirectory } from "#lib/repository";

describe("release repository", () => {
	test("defaults to the fork and normalizes GitHub casing", () => {
		assert.strictEqual(parseRepository().name, "kjanat/dprint");
		assert.strictEqual(parseRepository(" ").name, "kjanat/dprint");
		assert.deepStrictEqual(parseRepository(" DPRINT/Dprint "), parseRepository("dprint/dprint"));
	});

	for (
		const input of [
			"dprint",
			"https://github.com/kjanat/dprint",
			"../dprint",
			"kjanat/../dprint",
			"kjanat/dprint?x=1",
			"kjanat/.",
		]
	) {
		test(`rejects invalid repository ${input}`, () => {
			assert.throws(() => parseRepository(input), /Expected owner\/repo/);
		});
	}

	test("does not collapse distinct repository names into one namespace", () => {
		assert.notStrictEqual(parseRepository("a-b/c").cacheKey, parseRepository("a/b-c").cacheKey);
		assert.notStrictEqual(parseRepository("a-b/c_d").cacheKey, parseRepository("a/b-c_d").cacheKey);
	});

	test("isolates sequential invocations without nesting and respects a changed cache root", () => {
		const root = join(import.meta.dirname, "cache");
		const fork = resolvePluginCacheDirectory(parseRepository(), { DPRINT_CACHE_DIR: root });
		const inherited = {
			DPRINT_CACHE_DIR: fork.directory,
			[PLUGIN_CACHE_ENVIRONMENT.root]: fork.root,
			[PLUGIN_CACHE_ENVIRONMENT.path]: fork.directory,
		};
		assert.deepStrictEqual(resolvePluginCacheDirectory(parseRepository(), inherited), fork);
		const upstream = resolvePluginCacheDirectory(parseRepository("dprint/dprint"), inherited);
		assert.strictEqual(upstream.root, root);
		assert.strictEqual(upstream.directory, join(root, "dprint_dprint"));
		assert.notStrictEqual(upstream.directory, fork.directory);
		const changed = resolvePluginCacheDirectory(parseRepository(), {
			...inherited,
			DPRINT_CACHE_DIR: join(root, "custom"),
		});
		assert.strictEqual(changed.directory, join(root, "custom", "kjanat_dprint"));
	});
});
