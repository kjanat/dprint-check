import { describe, expect, expectTypeOf, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import action from "#action.yml" with { type: "yaml" };
import { ACTION_INPUT, ACTION_OUTPUT, ACTION_VALUE, DPRINT } from "#lib/contracts";

const root = dirname(import.meta.dir);

expectTypeOf(action).not.toBeAny();
expectTypeOf(action.runs.using).toEqualTypeOf<"node24">();
expectTypeOf(action.inputs.token.default).toEqualTypeOf<"${{ github.token }}">();

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
			[ACTION_INPUT.runCheck, ACTION_VALUE.true],
			[ACTION_INPUT.configPath, ""],
			[ACTION_INPUT.args, ""],
		] as const,
	)("defaults %s to %s", (input, expected) => {
		expect(action.inputs[input].default).toBe(expected);
	});

	test("declares cache and installation outputs", () => {
		expect(action.outputs).toContainAllKeys(Object.values(ACTION_OUTPUT));
	});
});

test("dist contains exactly the configured entrypoints", async () => {
	const files = await readdir(join(root, "dist"), { withFileTypes: true });
	const actualFiles = files.filter(file => file.isFile()).map(file => file.name).toSorted();
	const expectedFiles = [action.runs.main, action.runs.post].map(path => basename(path)).toSorted();
	expect(actualFiles).toEqual(expectedFiles);
});
