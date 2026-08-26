import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { defineConfig, type TsdownHooks, type UserConfig } from "tsdown";
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

const emittedBundlePaths = new Set<string>();
let completedBuilds = 0;

const writeReleaseChecksum: TsdownHooks["build:done"] = async ({ chunks }) => {
	for (const chunk of chunks) {
		const outputPath = resolve(import.meta.dirname, chunk.outDir, chunk.fileName);
		emittedBundlePaths.add(relative(import.meta.dirname, outputPath).replaceAll("\\", "/"));
	}
	completedBuilds++;
	if (completedBuilds < sourceEntrypoints.length) return;

	const bundlePaths = [...emittedBundlePaths].toSorted();
	if (
		bundlePaths.length !== actionEntrypoints.length
		|| bundlePaths.some((path, index) => path !== actionEntrypoints[index])
	) {
		throw new Error(
			`Expected only Action entrypoints: ${actionEntrypoints.join(", ")}; emitted: ${bundlePaths.join(", ")}`,
		);
	}
	const lines = await Promise.all(actionEntrypoints.map(async path => {
		const hash = createHash("sha256").update(await readFile(resolve(import.meta.dirname, path))).digest("hex");
		return `${hash}  ${path}`;
	}));
	await writeFile(resolve(import.meta.dirname, "SHA256SUMS"), `${lines.join("\n")}\n`);
};

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
	hooks: { "build:done": writeReleaseChecksum },
})) satisfies UserConfig[];

export default defineConfig(configs);
