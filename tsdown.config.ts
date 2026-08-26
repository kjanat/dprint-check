import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { defineConfig } from "tsdown";
import { parse } from "yaml";

const entry = "./src/main.ts";
const actionEntrypoint = `dist/${basename(entry, ".ts")}.mjs`;

const declaresEntrypoint = (manifest: unknown, entrypoint: string): boolean => {
	if (typeof manifest !== "object" || manifest === null || !("runs" in manifest)) return false;
	const { runs } = manifest;
	if (typeof runs !== "object" || runs === null || !("main" in runs)) return false;
	return runs.main === entrypoint;
};

const manifest: unknown = parse(readFileSync(resolve(import.meta.dirname, "action.yml"), "utf8"));
if (!declaresEntrypoint(manifest, actionEntrypoint)) {
	throw new Error(`Expected action.yml to declare runs.main as ${actionEntrypoint}`);
}

export default defineConfig({
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
});
