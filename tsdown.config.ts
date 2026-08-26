import { globSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { defineConfig, type UserConfig } from "tsdown";
import { parse } from "yaml";

const sourceEntrypoints = globSync("src/*.ts", { cwd: import.meta.dirname }).toSorted();
const actionEntrypoints = sourceEntrypoints.map(source => `dist/${basename(source, ".ts")}.mjs`).toSorted();

const declaresEntrypoints = (manifest: unknown, entrypoints: readonly string[]): boolean => {
	if (typeof manifest !== "object" || manifest === null || !("runs" in manifest)) return false;
	const { runs } = manifest;
	if (typeof runs !== "object" || runs === null || !("main" in runs) || !("post" in runs)) return false;
	const declared = [runs.main, runs.post].toSorted();
	return declared.length === entrypoints.length
		&& declared.every((declaredPath, index) => declaredPath === entrypoints[index]);
};

const manifest: unknown = parse(readFileSync(resolve(import.meta.dirname, "action.yml"), "utf8"));
if (!declaresEntrypoints(manifest, actionEntrypoints)) {
	throw new Error(`Expected action.yml to declare runs.main and runs.post as ${actionEntrypoints.join(", ")}`);
}

const configs = sourceEntrypoints.map(entry => ({
	entry,
	minify: true,
	clean: true,
	target: "node24",
	platform: "node",
	outputOptions: {
		comments: {
			legal: true,
			annotation: false,
			jsdoc: false,
		},
	},
	env: {
		NODE_ENV: "production",
	},
	treeshake: true,
	deps: {
		alwaysBundle: ["detect-libc"],
		onlyBundle: false,
		onlyImport: [],
	},
})) satisfies UserConfig[];

export default defineConfig(configs);
