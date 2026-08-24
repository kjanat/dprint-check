import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { defineConfig, type TsdownHooks } from "tsdown";

import action from "./action.yml" with { type: "yaml" };

const actionEntrypoints = [action.runs.main, action.runs.post].toSorted();
const sourceEntrypoints = [...new Bun.Glob("./src/*.ts").scanSync()].toSorted();
const emittedBundlePaths = new Set<string>();
let completedBuilds = 0;

const writeReleaseChecksum: TsdownHooks["build:done"] = async ({ chunks }) => {
	for (const chunk of chunks) {
		const outputPath = resolve(import.meta.dir, chunk.outDir, chunk.fileName);
		emittedBundlePaths.add(relative(import.meta.dir, outputPath).replaceAll("\\", "/"));
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
		const hash = createHash("sha256").update(await readFile(resolve(import.meta.dir, path))).digest("hex");
		return `${hash}  ${path}`;
	}));
	await writeFile(resolve(import.meta.dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
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
})) satisfies import("tsdown").UserConfig[];

export default defineConfig(configs);
