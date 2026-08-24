import { describe, expect, expectTypeOf, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import action from "#action.yml" with { type: "yaml" };
import { ACTION_INPUT, ACTION_OUTPUT, ACTION_VALUE, DPRINT } from "#lib/contracts";

const root = dirname(import.meta.dir);

expectTypeOf(action).not.toBeAny();
expectTypeOf(action.runs.using).toEqualTypeOf<"node24">();
expectTypeOf(action.inputs.token.default).toEqualTypeOf<"${{ github.token }}">();
expectTypeOf(action.inputs.annotations.default).toEqualTypeOf<"true">();

describe("action metadata", () => {
	test("uses Node.js 24 with an always-running post step", () => {
		expect(action.runs).toEqual({
			using: "node24",
			main: "dist/main.mjs",
			post: "dist/post.mjs",
			"post-if": "always()",
		});
	});

	test("declares exactly the supported inputs", () => {
		expect(action.inputs).toContainAllKeys(Object.values(ACTION_INPUT));
	});

	test.each(
		[
			[ACTION_INPUT.dprintVersion, DPRINT.latestVersion],
			[ACTION_INPUT.token, "${{ github.token }}"],
			[ACTION_INPUT.cache, ACTION_VALUE.true],
			[ACTION_INPUT.installOnly, ACTION_VALUE.false],
			[ACTION_INPUT.configPath, ""],
			[ACTION_INPUT.annotations, ACTION_VALUE.true],
			[ACTION_INPUT.args, ""],
		] as const,
	)("defaults %s to %s", (input, expected) => {
		expect(action.inputs[input].default).toBe(expected);
	});

	test("declares cache and installation outputs", () => {
		expect(action.outputs).toContainAllKeys(Object.values(ACTION_OUTPUT));
	});
});

test("checksum manifest covers the bundle and configured entrypoints", async () => {
	const files = await readdir(join(root, "dist"), { withFileTypes: true });
	const bundlePaths = files.filter(file => file.isFile()).map(file => `dist/${file.name}`).toSorted();
	expect(bundlePaths).toEqual([action.runs.main, action.runs.post].toSorted());
	const checksums = (await readFile(join(root, "SHA256SUMS"), "utf8"))
		.trim()
		.split(/\r?\n/);
	const releasePaths = checksums.map(line => {
		expect(line).toMatch(/^[0-9a-f]{64} {2}.+$/);
		return line.slice(66);
	});
	expect(releasePaths.toSorted()).toEqual(bundlePaths);
});
