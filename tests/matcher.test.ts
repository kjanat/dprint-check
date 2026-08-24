import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { ENVIRONMENT } from "#lib/contracts";
import { DPRINT_PROBLEM_MATCHER, registerProblemMatcher } from "#lib/matcher";
import { useTestContext } from "#test/helpers";

const context = useTestContext();
const pattern = DPRINT_PROBLEM_MATCHER.problemMatcher[0].pattern[0];

test("writes the matcher to the runner temp directory and registers it", async () => {
	const temp = await context.temporaryDirectory("dprint-matcher-test-");
	context.setEnvironment(ENVIRONMENT.runnerTemporaryDirectory, temp);
	const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);

	try {
		const path = await registerProblemMatcher();
		expect(path.startsWith(temp)).toBeTrue();
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(DPRINT_PROBLEM_MATCHER);
		expect(stdout).toHaveBeenCalledWith(`::add-matcher::${path}\n`);
	} finally {
		stdout.mockRestore();
	}
});

test("matches only the file headers of captured dprint check output", () => {
	const regexp = new RegExp(pattern.regexp, "u");
	const output = readFileSync(new URL("./fixtures/dprint/stdout/check-multifile.txt", import.meta.url), "utf8");

	const matches = output.split("\n")
		.map(line => regexp.exec(line))
		.filter((match): match is RegExpExecArray => match !== null);

	expect(matches.map(match => match[pattern.file])).toEqual([
		"/workspace/markdown.md",
		"/workspace/powershell.ps1",
		"/workspace/typescript.ts",
	]);
	expect(matches.map(match => match[pattern.message])).toEqual([
		"from /workspace/markdown.md:",
		"from /workspace/powershell.ps1:",
		"from /workspace/typescript.ts:",
	]);
});

test("matches a Windows file header", () => {
	const regexp = new RegExp(pattern.regexp, "u");
	const match = regexp.exec("from D:\\a\\check\\check\\README.md:");
	expect(match?.[pattern.file]).toBe("D:\\a\\check\\check\\README.md");
});
