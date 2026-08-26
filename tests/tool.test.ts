import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";

import { DPRINT, ENVIRONMENT } from "#lib/contracts";
import { downloadTool, extractZip } from "#lib/tool";
import { TEST_DPRINT_ASSET, useTestContext } from "#test/helpers";

const execFileAsync = promisify(execFile);
const context = useTestContext();

describe("downloadTool", () => {
	test("retries transient responses and streams the download", async t => {
		const root = await context.temporaryDirectory("dprint-tool-");
		context.setEnvironment(ENVIRONMENT.runnerTemporaryDirectory, root);
		const responses = [new Response("try later", { status: 503 }), new Response("dprint binary")];
		const fetch = t.mock.fn(async (): Promise<Response> => {
			const response = responses.shift();
			if (response === undefined) throw new Error("Unexpected request");
			return response;
		});
		const sleep = t.mock.fn(async () => {});

		const downloaded = await downloadTool(`https://example.com/${TEST_DPRINT_ASSET}`, { fetch, sleep });

		assert.strictEqual(await readFile(downloaded, "utf8"), "dprint binary");
		assert.strictEqual(fetch.mock.callCount(), 2);
		assert.strictEqual(sleep.mock.callCount(), 1);
		assert.deepStrictEqual(sleep.mock.calls[0]?.arguments, [1000]);
	});

	test("does not retry a permanent response", async t => {
		const root = await context.temporaryDirectory("dprint-tool-");
		context.setEnvironment(ENVIRONMENT.runnerTemporaryDirectory, root);
		const fetch = t.mock.fn(async () => new Response("forbidden", { status: 403 }));
		const sleep = t.mock.fn(async () => {});

		await assert.rejects(downloadTool(`https://example.com/${TEST_DPRINT_ASSET}`, { fetch, sleep }), {
			message: "Download failed with HTTP 403",
		});
		assert.strictEqual(fetch.mock.callCount(), 1);
		assert.strictEqual(sleep.mock.callCount(), 0);
	});
});

test("extracts a downloaded ZIP archive", async () => {
	if (process.platform === "win32") return;
	const root = await context.temporaryDirectory("dprint-tool-");
	context.setEnvironment(ENVIRONMENT.runnerTemporaryDirectory, root);
	const contents = join(root, "contents");
	const archive = join(root, TEST_DPRINT_ASSET);
	await mkdir(contents);
	await writeFile(join(contents, DPRINT.name), "binary");
	await execFileAsync("zip", ["-q", archive, DPRINT.name], { cwd: contents });

	const extracted = await extractZip(archive);

	assert.strictEqual(await readFile(join(extracted, DPRINT.name), "utf8"), "binary");
});
