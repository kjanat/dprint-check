import { describe, expect, mock, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	AZURE_STORAGE_API_VERSION,
	CACHE_COMPRESSION,
	CACHE_MODE,
	CACHE_SERVICE_METHOD,
	cacheVersion,
	isCacheAvailable,
	restoreCache,
	saveCache,
} from "#lib/cache";
import { ENVIRONMENT } from "#lib/contracts";
import { GITHUB_API } from "#lib/github";
import { useTestContext } from "#test/helpers";

const context = useTestContext();
const RESULTS_URL = "https://results.example/";
const RUNTIME_TOKEN = "runtime-token";
const BLOB_URL = `https://blob.example/cache?sv=${AZURE_STORAGE_API_VERSION}`;
const cacheServiceEnvironment = {
	[ENVIRONMENT.actionsResultsUrl]: RESULTS_URL,
	[ENVIRONMENT.actionsRuntimeToken]: RUNTIME_TOKEN,
};

describe("cache availability", () => {
	test.each(
		[
			{
				name: "GitHub-hosted v2 service",
				environment: {
					[ENVIRONMENT.githubServerUrl]: GITHUB_API.webUrl,
					...cacheServiceEnvironment,
				},
				expected: true,
			},
			{
				name: "missing runtime token",
				environment: {
					[ENVIRONMENT.githubServerUrl]: GITHUB_API.webUrl,
					[ENVIRONMENT.actionsResultsUrl]: RESULTS_URL,
				},
				expected: false,
			},
			{
				name: "GHES v1 service",
				environment: {
					[ENVIRONMENT.githubServerUrl]: "https://github.example.com",
					...cacheServiceEnvironment,
				},
				expected: false,
			},
		] as const,
	)("reports $name", ({ environment, expected }) => {
		expect(isCacheAvailable(environment)).toBe(expected);
	});

	test("matches actions/cache's version hash", () => {
		expect(cacheVersion(["/workspace/.cache/dprint"], CACHE_COMPRESSION.zstd)).toBe(
			"979a993c2384ea042ce6dd2bd47ca935ddb2248a5a8759bd4fdd358701a07242",
		);
	});
});

test("saves and restores an exact directory through the v2 protocol", async () => {
	const root = await context.temporaryDirectory("dprint-cache-test-");
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
			if (method === CACHE_SERVICE_METHOD.create) {
				return Response.json({ ok: true, signed_upload_url: BLOB_URL });
			}
			if (method === CACHE_SERVICE_METHOD.finalize) return Response.json({ ok: true, entry_id: "1" });
			if (method === CACHE_SERVICE_METHOD.restore) {
				return Response.json({
					ok: true,
					signed_download_url: BLOB_URL,
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
		[ENVIRONMENT.githubServerUrl]: GITHUB_API.webUrl,
		[ENVIRONMENT.githubWorkspace]: workspace,
		[ENVIRONMENT.runnerTemporaryDirectory]: join(root, "temp"),
		...cacheServiceEnvironment,
	};
	const options = { debug: mock(() => {}), environment, fetch, maskSecret: mock(() => {}) };

	await saveCache([cachePath], "plugin-cache-primary", options);
	await rm(cachePath, { recursive: true });
	expect(await restoreCache([cachePath], "plugin-cache-primary", ["plugin-cache-"], options)).toBe(
		"plugin-cache-restore-hit",
	);
	expect(await readFile(join(cachePath, "plugin.wasm"), "utf8")).toBe("cached plugin");
	expect(serviceRequests.map(request => request.method)).toEqual([
		CACHE_SERVICE_METHOD.create,
		CACHE_SERVICE_METHOD.finalize,
		CACHE_SERVICE_METHOD.restore,
	]);
	expect(serviceRequests[2]?.body).toMatchObject({
		key: "plugin-cache-primary",
		restore_keys: ["plugin-cache-"],
	});
	expect(serviceRequests[2]?.body.version).toBe(serviceRequests[0]?.body.version);
	expect(Number(serviceRequests[1]?.body.size_bytes)).toBePositive();
	expect(blocks.size).toBePositive();
	expect(options.maskSecret).toHaveBeenCalledTimes(2);
	expect(options.maskSecret).toHaveBeenNthCalledWith(1, BLOB_URL);
	expect(options.maskSecret).toHaveBeenNthCalledWith(2, BLOB_URL);
});

test("honors cache-mode before executing or requesting anything", async () => {
	const execute = mock(async () => {
		throw new Error("should not execute");
	});
	const fetch = mock(async () => {
		throw new Error("should not fetch");
	});
	const environment = { [ENVIRONMENT.actionsCacheMode]: CACHE_MODE.none };

	expect(restoreCache(["cache"], "key", [], { environment, execute, fetch })).resolves.toBeUndefined();
	expect(saveCache(["cache"], "key", { environment, execute, fetch })).resolves.toBeUndefined();
	expect(execute).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});

test.each([408, 429, 503])("retries transient HTTP %i cache-service failures", status => {
	const fetch = mock()
		.mockResolvedValueOnce(Response.json({ msg: "temporary failure" }, { status }))
		.mockResolvedValueOnce(Response.json({ ok: false }));
	const execute = mock(async () => {});
	const sleep = mock(async () => {});
	const debug = mock(() => {});
	const environment = cacheServiceEnvironment;

	expect(restoreCache(["cache"], "key", [], { debug, environment, execute, fetch, sleep })).resolves
		.toBeUndefined();
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(sleep).toHaveBeenCalledTimes(1);
	expect(debug).toHaveBeenCalledTimes(1);
	expect(debug).toHaveBeenCalledWith("Cache request attempt 1/3 failed; retrying");
});

test("does not retry cache-service authorization failures", () => {
	const fetch = mock(async () => Response.json({ msg: "cache read denied" }, { status: 403 }));
	const execute = mock(async () => {});
	const sleep = mock(async () => {});
	const environment = cacheServiceEnvironment;

	expect(restoreCache(["cache"], "key", [], { environment, execute, fetch, sleep })).rejects.toThrow(
		"cache read denied",
	);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(sleep).not.toHaveBeenCalled();
});
