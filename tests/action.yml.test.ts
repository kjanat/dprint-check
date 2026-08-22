import { describe, expect, expectTypeOf, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import action from "#action.yml" with { type: "yaml" };

const root = dirname(import.meta.dir);

expectTypeOf(action).not.toBeAny();
expectTypeOf(action.runs.using).toEqualTypeOf<"node24">();
expectTypeOf(action.inputs.token.default).toEqualTypeOf<"${{ github.token }}">();

describe("action metadata", () => {
	test("uses Node.js 24 with an always-running post step", () => {
		expect(action.runs).toMatchObject({
			using: "node24",
			main: "dist/main.mjs",
			post: "dist/post.mjs",
			"post-if": "always()",
		});
	});

	test("keeps existing inputs", () => {
		expect(Object.keys(action.inputs)).toEqual([
			"dprint-version",
			"token",
			"cache",
			"run-check",
			"config-path",
			"args",
		]);
	});

	test.each(
		[
			["dprint-version", "latest"],
			["token", "${{ github.token }}"],
			["cache", "true"],
			["run-check", "true"],
		] as const,
	)("defaults %s to %s", (input, expected) => {
		expect(action.inputs[input].default).toBe(expected);
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
