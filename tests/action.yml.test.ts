import { expectTypeOf } from "expect-type";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { parse } from "yaml";

import { ACTION_INPUT, ACTION_OUTPUT, ACTION_VALUE, DPRINT } from "#lib/contracts";
import type declaredAction from "../action.yml.d.ts";

type DeclaredManifest = typeof declaredAction;

type ManifestInput = Readonly<{ description: string; required: boolean; default: string }>;

type ManifestOutput = Readonly<{ description: string }>;

type ActionManifest = Readonly<{
	inputs: Readonly<Record<string, ManifestInput>>;
	outputs: Readonly<Record<string, ManifestOutput>>;
	runs: Readonly<{ using: string; main: string; post: string; "post-if": string }>;
}>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isManifestInput = (value: unknown): value is ManifestInput =>
	isRecord(value) && typeof value["description"] === "string" && typeof value["required"] === "boolean"
	&& typeof value["default"] === "string";

const isManifestOutput = (value: unknown): value is ManifestOutput =>
	isRecord(value) && typeof value["description"] === "string";

const isActionManifest = (value: unknown): value is ActionManifest => {
	if (!isRecord(value)) return false;
	const { inputs, outputs, runs } = value;
	if (!isRecord(inputs) || !isRecord(outputs) || !isRecord(runs)) return false;
	return Object.values(inputs).every(isManifestInput) && Object.values(outputs).every(isManifestOutput)
		&& typeof runs["using"] === "string" && typeof runs["main"] === "string" && typeof runs["post"] === "string"
		&& typeof runs["post-if"] === "string";
};

const root = dirname(import.meta.dirname);

const manifest: unknown = parse(await readFile(join(root, "action.yml"), "utf8"));
if (!isActionManifest(manifest)) throw new Error("action.yml does not declare inputs, outputs, and runs");
const action = manifest;

expectTypeOf<DeclaredManifest>().not.toBeAny();
expectTypeOf<DeclaredManifest["runs"]["using"]>().toEqualTypeOf<"node24">();
expectTypeOf<DeclaredManifest["inputs"]["token"]["default"]>().toEqualTypeOf<"${{ github.token }}">();
expectTypeOf<DeclaredManifest["inputs"]["cache"]["default"]>().toEqualTypeOf<"true">();
expectTypeOf<DeclaredManifest["inputs"]["install-only"]["default"]>().toEqualTypeOf<"false">();
expectTypeOf<DeclaredManifest["inputs"]["annotations"]["default"]>().toEqualTypeOf<"true">();

describe("action metadata", () => {
	test("uses Node.js 24 with an always-running post step", () => {
		assert.deepStrictEqual(action.runs, {
			using: "node24",
			main: "dist/main.mjs",
			post: "dist/post.mjs",
			"post-if": "always()",
		});
	});

	test("declares exactly the supported inputs", () => {
		assert.deepStrictEqual(Object.keys(action.inputs).toSorted(), Object.values(ACTION_INPUT).toSorted());
	});

	const defaults = [
		[ACTION_INPUT.dprintVersion, DPRINT.latestVersion],
		[ACTION_INPUT.token, "${{ github.token }}"],
		[ACTION_INPUT.cache, ACTION_VALUE.true],
		[ACTION_INPUT.installOnly, ACTION_VALUE.false],
		[ACTION_INPUT.configPath, ""],
		[ACTION_INPUT.annotations, ACTION_VALUE.true],
		[ACTION_INPUT.args, ""],
	] as const;

	for (const [input, expected] of defaults) {
		test(`defaults ${input} to ${expected}`, () => {
			assert.strictEqual(action.inputs[input]?.default, expected);
		});
	}

	test("declares cache and installation outputs", () => {
		assert.deepStrictEqual(Object.keys(action.outputs).toSorted(), Object.values(ACTION_OUTPUT).toSorted());
	});
});

test("bundles exactly the configured entrypoints", async () => {
	const files = await readdir(join(root, "dist"), { withFileTypes: true });
	const bundlePaths = files.filter(file => file.isFile()).map(file => `dist/${file.name}`).toSorted();
	assert.deepStrictEqual(bundlePaths, [action.runs.main, action.runs.post].toSorted());
});
