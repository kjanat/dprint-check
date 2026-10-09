import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import * as actions from "#lib/actions";
import * as config from "#lib/config";
import type { ExistingSuggestion } from "#lib/review-threads";
import type { FormattingDiff } from "#lib/suggestions";
import { useTestContext } from "#test/helpers";

const context = useTestContext();

test("main gates review flags by binary capabilities and preserves formatting status", async t => {
	const initialExitCode = process.exitCode;
	const inputs: Record<string, string> = {
		"install-only": "true",
		cache: "false",
		review: "true",
		annotations: "false",
	};
	const commands: string[][] = [];
	const reviews: Array<readonly FormattingDiff[]> = [];
	const warnings: string[] = [];
	const annotations: Array<NonNullable<Parameters<typeof actions.error>[1]>> = [];
	const failures: string[] = [];
	const configRoots: string[] = [];
	let covered: readonly ExistingSuggestion[] = [];
	let brokenConfig: string | undefined;
	let supportsJson = false;
	let clean = false;
	const diff = { file: "README.md", diff: "--- original\n+++ formatted\n@@ -1 +1 @@\n-old\n+new\n" };
	let emittedDiff = diff;
	const actionsMock = {
		cache: false,
		exports: {
			...actions,
			getInput: (name: string) => inputs[name] ?? "",
			info: () => {},
			debug: () => {},
			exportVariable: () => {},
			setOutput: () => {},
			warning: (message: string) => warnings.push(message),
			error: (_message: string, properties: NonNullable<Parameters<typeof actions.error>[1]>) => {
				annotations.push(properties);
			},
			setFailed: (message: string) => {
				failures.push(message);
				process.exitCode = 1;
			},
		},
	};
	t.mock.module("#lib/actions", actionsMock);
	const installMock = {
		cache: false,
		exports: {
			installDprint: async () => ({ version: "test", location: "/tools/dprint", platformKey: "test", cacheHit: false }),
		},
	};
	t.mock.module("#lib/install", installMock);
	const configMock = { cache: false, exports: { ...config, findConfigFiles: async () => configRoots } };
	t.mock.module("#lib/config", configMock);
	const execMock = {
		cache: false,
		exports: {
			execFileAsync: async (_binary: string, args: string[]) => {
				commands.push(args);
				if (args.includes("--help")) {
					return {
						stdout: supportsJson
							? "Options:\n --json\n --diff-format <format>\n unified\n"
							: "Options:\n --list-different\n",
					};
				}
				if (clean) return {};
				if (brokenConfig !== undefined && args.includes(brokenConfig)) {
					throw Object.assign(new Error("Broken config"), { code: 1 });
				}
				throw Object.assign(new Error("Formatting failed"), {
					code: 20,
					stdout: args.includes("--json")
						? `${JSON.stringify(emittedDiff)}\n`
						: "from README.md:\n  1|-old\n1  |+new\n--\n",
				});
			},
		},
	};
	t.mock.module("#lib/exec", execMock);
	const reviewMock = {
		cache: false,
		exports: {
			postFormattingReview: async (diffs: readonly FormattingDiff[]) => {
				reviews.push(diffs);
				return covered;
			},
		},
	};
	t.mock.module("#lib/review", reviewMock);
	t.mock.method(process.stdout, "write", () => true);
	try {
		const { run } = await import("#main");
		await run();
		assert.deepEqual(commands, []); // install-only never probes/checks/posts
		assert.deepEqual(reviews, []);
		inputs["install-only"] = "false";
		await run();
		assert.deepEqual(commands, [["check", "--help"], ["check"]]);
		assert.deepEqual(reviews, []);
		assert.match(warnings[0] ?? "", /does not advertise JSON/u);
		assert.equal(process.exitCode, 1);
		supportsJson = true;
		commands.length = 0;
		await run();
		assert.deepEqual(commands, [["check", "--help"], ["check", "--diff-format", "unified", "--json"]]);
		assert.deepEqual(reviews, [[diff]]);
		assert.equal(process.exitCode, 1);
		clean = true;
		process.exitCode = undefined;
		await run();
		assert.equal(reviews.length, 1); // clean check posts no review
		assert.equal(process.exitCode, undefined);
		inputs.review = "false";
		commands.length = 0;
		await run();
		assert.deepEqual(commands, [["check"]]); // default behavior needs no capability probe
		inputs.review = "true";
		inputs.annotations = "true";
		clean = false;
		emittedDiff = { ...diff, diff: `${diff.diff}@@ -4 +4 @@\n-old2\n+new2\n` };
		covered = [{ path: "README.md", startLine: 1, endLine: 1, replacement: ["new"] }];
		await run();
		assert.deepEqual(annotations.map(annotation => annotation.line), [4]); // another range in the same file remains visible
		annotations.length = 0;
		const previousWorkspace = process.env.GITHUB_WORKSPACE;
		context.setEnvironment("GITHUB_WORKSPACE", "C:\\runner\\project");
		emittedDiff = { ...emittedDiff, file: "C:\\runner\\project\\src\\example.ts" };
		covered = [{ path: "src/example.ts", startLine: 1, endLine: 1, replacement: ["new"] }];
		await run();
		assert.deepEqual(annotations.map(({ file, line }) => ({ file, line })), [{ file: "src/example.ts", line: 4 }]);
		annotations.length = 0;
		context.setEnvironment("GITHUB_WORKSPACE", previousWorkspace);
		emittedDiff = { ...emittedDiff, file: "README.md" };
		covered = [];
		await run();
		assert.deepEqual(annotations.map(annotation => annotation.line), [1, 4]); // unavailable coverage retains all annotations
		annotations.length = 0;
		const directory = await context.temporaryDirectory("dprint-review-config-");
		const first = join(directory, "first.json");
		const second = join(directory, "second.json");
		await writeFile(first, "{\"plugins\": []}");
		await writeFile(second, "{\"plugins\": []}");
		configRoots.push(first, second);
		inputs["config-path"] = "explicit-configs";
		brokenConfig = second;
		const previousReviews = reviews.length;
		await run();
		assert.equal(reviews.length, previousReviews); // interrupted result is never published
		assert.deepEqual(annotations.map(annotation => annotation.line), [1, 4]); // earlier findings still reach workflow annotations
		assert.deepEqual(failures, ["Broken config"]);
		assert.equal(process.exitCode, 1);
	} finally {
		process.exitCode = initialExitCode;
	}
});
