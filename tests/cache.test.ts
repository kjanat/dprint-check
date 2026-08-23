import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cacheVersion, isCacheAvailable, restoreCache, saveCache } from "#lib/cache";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("cache availability", () => {
	test.each(
		[
			{
				name: "GitHub-hosted v2 service",
				environment: {
					GITHUB_SERVER_URL: "https://github.com",
					ACTIONS_RESULTS_URL: "https://results.example/",
					ACTIONS_RUNTIME_TOKEN: "token",
				},
				expected: true,
			},
			{
				name: "missing runtime token",
				environment: { GITHUB_SERVER_URL: "https://github.com", ACTIONS_RESULTS_URL: "https://results.example/" },
				expected: false,
			},
			{
				name: "GHES v1 service",
				environment: {
					GITHUB_SERVER_URL: "https://github.example.com",
					ACTIONS_RESULTS_URL: "https://results.example/",
					ACTIONS_RUNTIME_TOKEN: "token",
				},
				expected: false,
			},
		] as const,
	)("reports $name", ({ environment, expected }) => {
		expect(isCacheAvailable(environment)).toBe(expected);
	});

	test("matches actions/cache's version hash", () => {
		expect(cacheVersion(["/workspace/.cache/dprint"], "zstd-without-long")).toBe(
			"979a993c2384ea042ce6dd2bd47ca935ddb2248a5a8759bd4fdd358701a07242",
		);
	});
});

test("saves and restores an exact directory through the v2 protocol", async () => {
	const root = await mkdtemp(join(tmpdir(), "dprint-cache-test-"));
	temporaryDirectories.push(root);
	const workspace = join(root, "workspace");
	const cachePath = join(root, "cache");
	await mkdir(workspace);
	await mkdir(cachePath);
	await writeFile(join(cachePath, "plugin.wasm"), "cached plugin");

	const serviceRequests: Array<{ method: string; body: Record<string, unknown> }> = [];
	const blocks = new Map<string, Uint8Array>();
	let archive = new Uint8Array();
	const fetch = mock(async (input: string | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const method = url.pathname.split("/").pop() ?? "";
		if (url.hostname === "results.example") {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			serviceRequests.push({ method, body });
			if (method === "CreateCacheEntry") {
				return Response.json({ ok: true, signed_upload_url: "https://blob.example/cache?sv=2021-12-02" });
			}
			if (method === "FinalizeCacheEntryUpload") return Response.json({ ok: true, entry_id: "1" });
			if (method === "GetCacheEntryDownloadURL") {
				return Response.json({
					ok: true,
					signed_download_url: "https://blob.example/cache?sv=2021-12-02",
					matched_key: "plugin-cache-restore-hit",
				});
			}
		}
		if (url.hostname === "blob.example" && init?.method === "PUT") {
			if (url.searchParams.get("comp") === "block") {
				const blockId = url.searchParams.get("blockid") ?? "";
				blocks.set(blockId, new Uint8Array(await new Response(init.body).arrayBuffer()));
			} else if (url.searchParams.get("comp") === "blocklist") {
				archive = Buffer.concat([...blocks.values()].map(block => Buffer.from(block)));
			}
			return new Response(null, { status: 201 });
		}
		if (url.hostname === "blob.example") return new Response(archive);
		return new Response(null, { status: 404 });
	});
	const environment = {
		GITHUB_SERVER_URL: "https://github.com",
		GITHUB_WORKSPACE: workspace,
		RUNNER_TEMP: join(root, "temp"),
		ACTIONS_RESULTS_URL: "https://results.example/",
		ACTIONS_RUNTIME_TOKEN: "runtime-token",
	};
	const options = { debug: mock(() => {}), environment, fetch, maskSecret: mock(() => {}) };

	await saveCache([cachePath], "plugin-cache-primary", options);
	await rm(cachePath, { recursive: true });
	expect(await restoreCache([cachePath], "plugin-cache-primary", ["plugin-cache-"], options)).toBe(
		"plugin-cache-restore-hit",
	);
	expect(await readFile(join(cachePath, "plugin.wasm"), "utf8")).toBe("cached plugin");
	expect(serviceRequests.map(request => request.method)).toEqual([
		"CreateCacheEntry",
		"FinalizeCacheEntryUpload",
		"GetCacheEntryDownloadURL",
	]);
	expect(serviceRequests[2]?.body).toMatchObject({
		key: "plugin-cache-primary",
		restore_keys: ["plugin-cache-"],
	});
	expect(serviceRequests[2]?.body.version).toBe(serviceRequests[0]?.body.version);
	expect(Number(serviceRequests[1]?.body.size_bytes)).toBeGreaterThan(0);
	expect(blocks.size).toBeGreaterThan(0);
	expect(options.maskSecret).toHaveBeenCalledTimes(2);
});

test("honors cache-mode before executing or requesting anything", async () => {
	const execute = mock(async () => {
		throw new Error("should not execute");
	});
	const fetch = mock(async () => {
		throw new Error("should not fetch");
	});
	const environment = { ACTIONS_CACHE_MODE: "none" };

	expect(restoreCache(["cache"], "key", [], { environment, execute, fetch })).resolves.toBeUndefined();
	expect(saveCache(["cache"], "key", { environment, execute, fetch })).resolves.toBeUndefined();
	expect(execute).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});

test("retries transient cache-service failures", () => {
	const fetch = mock()
		.mockResolvedValueOnce(Response.json({ msg: "temporary failure" }, { status: 503 }))
		.mockResolvedValueOnce(Response.json({ ok: false }));
	const execute = mock(async () => {});
	const sleep = mock(async () => {});
	const debug = mock(() => {});
	const environment = {
		ACTIONS_RESULTS_URL: "https://results.example/",
		ACTIONS_RUNTIME_TOKEN: "runtime-token",
	};

	expect(restoreCache(["cache"], "key", [], { debug, environment, execute, fetch, sleep })).resolves
		.toBeUndefined();
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(sleep).toHaveBeenCalledTimes(1);
	expect(debug).toHaveBeenCalledTimes(1);
});

test("does not retry cache-service authorization failures", () => {
	const fetch = mock(async () => Response.json({ msg: "cache read denied" }, { status: 403 }));
	const execute = mock(async () => {});
	const sleep = mock(async () => {});
	const environment = {
		ACTIONS_RESULTS_URL: "https://results.example/",
		ACTIONS_RUNTIME_TOKEN: "runtime-token",
	};

	expect(restoreCache(["cache"], "key", [], { environment, execute, fetch, sleep })).rejects.toThrow(
		"cache read denied",
	);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(sleep).not.toHaveBeenCalled();
});
