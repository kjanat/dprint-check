import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { defineConfig, type TsdownHooks } from "tsdown";

import action from "./action.yml" with { type: "yaml" };

const actionEntrypoints = [action.runs.main, action.runs.post];

const writeReleaseChecksum: TsdownHooks["build:done"] = async ({ chunks }) => {
	const bundlePaths = chunks
		.map(chunk => relative(process.cwd(), resolve(chunk.outDir, chunk.fileName)).replaceAll("\\", "/"))
		.toSorted();
	for (const entrypoint of actionEntrypoints) {
		if (!bundlePaths.includes(entrypoint)) throw new Error(`Missing Action entrypoint: ${entrypoint}`);
	}
	const lines = await Promise.all(bundlePaths.map(async path => {
		const hash = createHash("sha256").update(await readFile(path)).digest("hex");
		return `${hash}  ${path}`;
	}));
	await writeFile("SHA256SUMS", `${lines.join("\n")}\n`);
};

export default defineConfig({
	entry: ["./src/*.ts"],
	minify: "dce-only",
	clean: true,
	target: "node24",
	platform: "node",
	env: {
		NODE_ENV: "production",
	},
	treeshake: true,
	deps: {
		alwaysBundle: [/.*/],
		onlyBundle: false,
		onlyImport: [],
	},
	hooks: { "build:done": writeReleaseChecksum },
});
