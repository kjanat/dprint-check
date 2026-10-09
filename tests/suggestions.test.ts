import assert from "node:assert/strict";
import { test } from "node:test";

import { createSuggestions, parseFormattingDiffs, suggestionBody } from "#lib/suggestions";

const workspace = "C:\\Users\\kjanat\\Projects\\dprint-check";
const file = `${workspace}\\README.md`;
const diff = (...lines: string[]): string => ["--- original", "+++ formatted", ...lines, ""].join("\n");
const suggestions = (...lines: string[]) => createSuggestions([{ file, diff: diff(...lines) }], workspace);

test("user NDJSON example replaces original lines 16-17 with five formatted lines", () => {
	const replacement = [
		"    permissions: {",
		"      contents: read,",
		"      checks: write,",
		"      code-quality: write,",
		"    }",
	];
	const output = JSON.stringify({
		file,
		diff: diff(
			"@@ -13,8 +13,11 @@",
			" jobs:",
			"   style:",
			"     runs-on: ubuntu-latest",
			"-    permissions: { ",
			"-    contents: read, checks: write, code-quality: write }",
			...replacement.map(line => `+${line}`),
			"     steps: [uses: actions/checkout@v7, uses: kjanat/dprint-check@v3]",
			" ```",
			" ",
		),
	});
	assert.deepStrictEqual(createSuggestions(parseFormattingDiffs(output), workspace), [{
		path: "README.md",
		startLine: 16,
		endLine: 17,
		replacement,
	}]);
});

test("parses multiple NDJSON files and rejects malformed or pretty output", () => {
	const record = { file, diff: diff("@@ -1 +1 @@", "-old", "+new") };
	assert.deepStrictEqual(parseFormattingDiffs(`\n${JSON.stringify(record)}\r\n${JSON.stringify(record)}\n`), [
		record,
		record,
	]);
	for (const output of ["from file:", "[]", "null", "{\"file\":\"x\",\"diff\":4}", "{\"file\":\"\",\"diff\":\"\"}"]) {
		assert.throws(() => parseFormattingDiffs(output));
	}
});

test("context separates replacement blocks; hunks retain original coordinates", () => {
	assert.deepStrictEqual(
		suggestions(
			"@@ -3,3 +3,3 @@",
			"-one",
			"+ONE",
			" context",
			"-two",
			"+TWO",
			"@@ -20 +20 @@",
			"-three",
			"+THREE",
		),
		[
			{ path: "README.md", startLine: 3, endLine: 3, replacement: ["ONE"] },
			{ path: "README.md", startLine: 5, endLine: 5, replacement: ["TWO"] },
			{ path: "README.md", startLine: 20, endLine: 20, replacement: ["THREE"] },
		],
	);
});

test("insertion anchors preceding context without deleting that context", () => {
	assert.deepStrictEqual(suggestions("@@ -5,2 +5,3 @@", " before", "+insert", " after"), [
		{ path: "README.md", startLine: 5, endLine: 5, replacement: ["before", "insert"] },
	]);
});

test("insertion before first line anchors following context", () => {
	assert.deepStrictEqual(suggestions("@@ -1 +1,2 @@", "+insert", " first"), [
		{ path: "README.md", startLine: 1, endLine: 1, replacement: ["insert", "first"] },
	]);
});

test("insertion blocks sharing one context anchor merge to one faithful replacement", () => {
	assert.deepStrictEqual(suggestions("@@ -1 +1,3 @@", "+before", " retained", "+after"), [
		{ path: "README.md", startLine: 1, endLine: 1, replacement: ["before", "retained", "after"] },
	]);
});

test("deletion uses an empty replacement; additions to an empty original are skipped", () => {
	assert.deepStrictEqual(suggestions("@@ -3,2 +3,0 @@", "-one", "-two"), [
		{ path: "README.md", startLine: 3, endLine: 4, replacement: [] },
	]);
	assert.deepStrictEqual(suggestions("@@ -0,0 +1 @@", "+first"), []);
});

test("outside-workspace paths are excluded; relative paths become slash-separated", () => {
	const content = diff("@@ -1 +1 @@", "-old", "+new");
	assert.deepStrictEqual(
		createSuggestions([
			{ file: "../outside.ts", diff: content },
			{ file: "C:\\other\\file.ts", diff: content },
			{ file: `${workspace}-other\\file.ts`, diff: content },
			{ file: "src\\inside.ts", diff: content },
		], workspace),
		[{ path: "src/inside.ts", startLine: 1, endLine: 1, replacement: ["new"] }],
	);
	assert.deepStrictEqual(createSuggestions([{ file: "/project/src/file.ts", diff: content }], "/project"), [
		{ path: "src/file.ts", startLine: 1, endLine: 1, replacement: ["new"] },
	]);
});

test("CRLF source lines retain carriage returns, blank lines, and leading diff-like text", () => {
	const content = diff("@@ -1,2 +1,3 @@", "-old\r", "-\r", "+--- literal\r", "+\r", "+ trailing\r");
	assert.deepStrictEqual(createSuggestions([{ file, diff: content }], workspace), [
		{ path: "README.md", startLine: 1, endLine: 2, replacement: ["--- literal\r", "\r", " trailing\r"] },
	]);
});

test("captured fork NDJSON reconstructs exact CRLF formatted text", () => {
	const original = "const x={a:1};\r\nconst y=[1,2]\r\n";
	const record = {
		file,
		diff: diff(
			"@@ -1,2 +1,2 @@",
			"-const x={a:1};\r",
			"-const y=[1,2]\r",
			"+const x = { a: 1 };\r",
			"+const y = [1, 2];\r",
		),
	};
	const edits = createSuggestions(parseFormattingDiffs(JSON.stringify(record)), workspace);
	const applied = original.split("\n");
	for (const edit of edits.toSorted((a, b) => b.startLine - a.startLine)) {
		applied.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...edit.replacement);
	}
	assert.equal(applied.join("\n"), "const x = { a: 1 };\r\nconst y = [1, 2];\r\n");
});

test("malformed hunk lengths, overlapping ranges, and missing prefixes fail closed", () => {
	for (
		const content of [
			diff("@@ -1,2 +1 @@", "-old", "+new"),
			diff("@@ -1 +1 @@", "-old", "+new", "+excess"),
			diff("@@ -1 +1 @@", "unprefixed"),
			diff("@@ -0 +1 @@", "-old", "+new"),
			diff("@@ -2 +2 @@", "-old", "+new", "@@ -2 +3 @@", "-old", "+new"),
			"@@ -1 +1 @@\n-old\n+new\n",
		]
	) assert.throws(() => createSuggestions([{ file, diff: content }], workspace), /Invalid unified/u);
});

test("no-final-newline hunks are excluded while independent safe hunks remain", () => {
	assert.deepStrictEqual(
		suggestions(
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"@@ -9 +9 @@",
			"-last",
			"\\ No newline at end of file",
			"+LAST",
		),
		[{ path: "README.md", startLine: 1, endLine: 1, replacement: ["new"] }],
	);
});

test("line-ending-only changes are not representable as suggestions", () => {
	assert.deepStrictEqual(suggestions("@@ -1 +1 @@", "-same\r", "+same"), []);
});

test("deleting an empty original line still generates a deletion suggestion", () => {
	assert.deepStrictEqual(suggestions("@@ -3 +2,0 @@", "-"), [
		{ path: "README.md", startLine: 3, endLine: 3, replacement: [] },
	]);
});

test("suggestion fences cannot be closed by replacement backticks", () => {
	assert.equal(suggestionBody(["const x = 1;"]), "```suggestion\nconst x = 1;\n```");
	assert.equal(suggestionBody(["```typescript", "code", "```"]), "````suggestion\n```typescript\ncode\n```\n````");
	assert.equal(suggestionBody([]), "```suggestion\n```");
	assert.equal(suggestionBody([""]), "```suggestion\n\n```");
});

test("replacement by one blank line remains distinct from deleting a line", () => {
	assert.deepStrictEqual(suggestions("@@ -3 +3 @@", "-remove contents", "+"), [
		{ path: "README.md", startLine: 3, endLine: 3, replacement: [""] },
	]);
});
