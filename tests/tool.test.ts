import { describe, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { DPRINT, ENVIRONMENT } from "#lib/contracts";
import { cacheToolDirectory, downloadTool, extractZip, findTool } from "#lib/tool";
import { TEST_DPRINT_ASSET, TEST_DPRINT_VERSION, useTestContext } from "#test/helpers";

const execFileAsync = promisify(execFile);
const context = useTestContext();

test("stores and finds complete tool-cache entries", async () => {
	const root = await context.temporaryDirectory("dprint-tool-");
	const source = join(root, "source");
	const toolCache = join(root, "tool-cache");
	await mkdir(join(source, "nested"), { recursive: true });
	await writeFile(join(source, DPRINT.name), "binary");
	await writeFile(join(source, "nested", "metadata"), "metadata");
	context.setEnvironment(ENVIRONMENT.runnerToolCache, toolCache);

	expect(findTool(DPRINT.name, TEST_DPRINT_VERSION, "x64")).toBe("");
	const cached = await cacheToolDirectory(source, DPRINT.name, TEST_DPRINT_VERSION, "x64");

	expect(cached).toBe(join(toolCache, DPRINT.name, TEST_DPRINT_VERSION, "x64"));
	expect(findTool(DPRINT.name, TEST_DPRINT_VERSION, "x64")).toBe(cached);
	expect(await readFile(join(cached, DPRINT.name), "utf8")).toBe("binary");
	expect(await readFile(join(cached, "nested", "metadata"), "utf8")).toBe("metadata");
});

describe("downloadTool", () => {
	test("retries transient responses and streams the download", async () => {
		const root = await context.temporaryDirectory("dprint-tool-");
		context.setEnvironment(ENVIRONMENT.runnerTemporaryDirectory, root);
		const fetch = mock()
			.mockResolvedValueOnce(new Response("try later", { status: 503 }))
			.mockResolvedValueOnce(new Response("dprint binary"));
		const sleep = mock(async () => {});

		const downloaded = await downloadTool(`https://example.com/${TEST_DPRINT_ASSET}`, { fetch, sleep });

		expect(await readFile(downloaded, "utf8")).toBe("dprint binary");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith(1000);
	});

	test("does not retry a permanent response", async () => {
		const root = await context.temporaryDirectory("dprint-tool-");
		context.setEnvironment(ENVIRONMENT.runnerTemporaryDirectory, root);
		const fetch = mock(async () => new Response("forbidden", { status: 403 }));
		const sleep = mock(async () => {});

		expect(downloadTool(`https://example.com/${TEST_DPRINT_ASSET}`, { fetch, sleep })).rejects.toThrow(
			"Download failed with HTTP 403",
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
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

	expect(await readFile(join(extracted, DPRINT.name), "utf8")).toBe("binary");
});
