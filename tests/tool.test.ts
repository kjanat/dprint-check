import { afterEach, describe, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { cacheToolDirectory, downloadTool, extractZip, findTool } from "#lib/tool";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const originalEnvironment = new Map<string, string | undefined>();

function setEnvironment(name: string, value: string | undefined): void {
	if (!originalEnvironment.has(name)) originalEnvironment.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterEach(async () => {
	for (const [name, value] of originalEnvironment) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	originalEnvironment.clear();
	await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test("stores and finds complete tool-cache entries", async () => {
	const root = await mkdtemp(join(tmpdir(), "dprint-tool-"));
	temporaryDirectories.push(root);
	const source = join(root, "source");
	const toolCache = join(root, "tool-cache");
	await mkdir(join(source, "nested"), { recursive: true });
	await writeFile(join(source, "dprint"), "binary");
	await writeFile(join(source, "nested", "metadata"), "metadata");
	setEnvironment("RUNNER_TOOL_CACHE", toolCache);

	expect(findTool("dprint", "0.56.1", "x64")).toBe("");
	const cached = await cacheToolDirectory(source, "dprint", "0.56.1", "x64");

	expect(cached).toBe(join(toolCache, "dprint", "0.56.1", "x64"));
	expect(findTool("dprint", "0.56.1", "x64")).toBe(cached);
	expect(await readFile(join(cached, "dprint"), "utf8")).toBe("binary");
	expect(await readFile(join(cached, "nested", "metadata"), "utf8")).toBe("metadata");
});

describe("downloadTool", () => {
	test("retries transient responses and streams the download", async () => {
		const root = await mkdtemp(join(tmpdir(), "dprint-tool-"));
		temporaryDirectories.push(root);
		setEnvironment("RUNNER_TEMP", root);
		const fetch = mock()
			.mockResolvedValueOnce(new Response("try later", { status: 503 }))
			.mockResolvedValueOnce(new Response("dprint binary"));
		const sleep = mock(async () => {});

		const downloaded = await downloadTool("https://example.com/dprint.zip", { fetch, sleep });

		expect(await readFile(downloaded, "utf8")).toBe("dprint binary");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith(1000);
	});

	test("does not retry a permanent response", async () => {
		const root = await mkdtemp(join(tmpdir(), "dprint-tool-"));
		temporaryDirectories.push(root);
		setEnvironment("RUNNER_TEMP", root);
		const fetch = mock(async () => new Response("forbidden", { status: 403 }));
		const sleep = mock(async () => {});

		expect(downloadTool("https://example.com/dprint.zip", { fetch, sleep })).rejects.toThrow(
			"Download failed with HTTP 403",
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});
});

test("extracts a downloaded ZIP archive", async () => {
	if (process.platform === "win32") return;
	const root = await mkdtemp(join(tmpdir(), "dprint-tool-"));
	temporaryDirectories.push(root);
	setEnvironment("RUNNER_TEMP", root);
	const contents = join(root, "contents");
	const archive = join(root, "dprint.zip");
	await mkdir(contents);
	await writeFile(join(contents, "dprint"), "binary");
	await execFileAsync("zip", ["-q", archive, "dprint"], { cwd: contents });

	const extracted = await extractZip(archive);

	expect(await readFile(join(extracted, "dprint"), "utf8")).toBe("binary");
});
