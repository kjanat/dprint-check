import { defineConfig } from "tsdown";

const shared = {
	minify: "dce-only",
	clean: true,
	target: "node24",
	deps: {
		alwaysBundle: [/.*/],
		onlyBundle: false,
		onlyImport: [],
	},
	outputOptions: { codeSplitting: false },
} satisfies import("tsdown").UserConfig;

export default defineConfig([{
	...shared,
	name: "main",
	entry: { main: "./src/main.ts" },
}, {
	...shared,
	name: "post",
	entry: { post: "./src/post.ts" },
}]);
