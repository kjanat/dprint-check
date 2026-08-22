import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import action from "../action.yml" with { type: "yaml" };

const root = dirname(import.meta.dir);

describe("action metadata", () => {
	test("uses Node.js 24 with an always-running post step", () => {
		expect(action.runs).toMatchObject({
			using: "node24",
			main: "dist/main.mjs",
			post: "dist/post.mjs",
			"post-if": "always()",
		});
	});

	test("keeps existing inputs and enables caching by default", () => {
		expect(Object.keys(action.inputs)).toEqual(["dprint-version", "cache", "run-check", "config-path", "args"]);
		expect(action.inputs.cache.default).toBe("true");
		expect(action.inputs["run-check"].default).toBe("true");
	});

	test("declares cache and installation outputs", () => {
		expect(Object.keys(action.outputs).toSorted()).toEqual([
			"cache-hit",
			"location",
			"plugin-cache-hit",
			"plugin-cache-key",
			"version",
		]);
	});
});

test("dist contains exactly the configured entrypoints", async () => {
	const files = await readdir(join(root, "dist"), { withFileTypes: true });
	const actualFiles = files.filter(file => file.isFile()).map(file => file.name).toSorted();
	const expectedFiles = [action.runs.main, action.runs.post].map(path => basename(path)).toSorted();
	expect(actualFiles).toEqual(expectedFiles);
});
