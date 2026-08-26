import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";

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
	const cases = [
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
	] as const;

	for (const { name, environment, expected } of cases) {
		test(`reports ${name}`, () => {
			assert.strictEqual(isCacheAvailable(environment), expected);
		});
	}

	test("matches actions/cache's version hash", () => {
		assert.strictEqual(
			cacheVersion(["/workspace/.cache/dprint"], CACHE_COMPRESSION.zstd),
			"979a993c2384ea042ce6dd2bd47ca935ddb2248a5a8759bd4fdd358701a07242",
		);
	});
});

test("saves and restores an exact directory through the v2 protocol", async t => {
	const root = await context.temporaryDirectory("dprint-cache-test-");
	const workspace = join(root, "workspace");
	const cachePath = join(root, "cache");
	await mkdir(workspace);
	await mkdir(cachePath);
	await writeFile(join(cachePath, "plugin.wasm"), "cached plugin");

	const serviceRequests: Array<{ method: string; body: Record<string, unknown> }> = [];
	const blocks = new Map<string, Uint8Array>();
	let archive = new Uint8Array();
	const fetch = t.mock.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
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
	const options = {
		debug: t.mock.fn(() => {}),
		environment,
		fetch,
		maskSecret: t.mock.fn(() => {}),
	};

	await saveCache([cachePath], "plugin-cache-primary", options);
	await rm(cachePath, { recursive: true });
	assert.strictEqual(
		await restoreCache([cachePath], "plugin-cache-primary", ["plugin-cache-"], options),
		"plugin-cache-restore-hit",
	);
	assert.strictEqual(await readFile(join(cachePath, "plugin.wasm"), "utf8"), "cached plugin");
	assert.deepStrictEqual(serviceRequests.map(request => request.method), [
		CACHE_SERVICE_METHOD.create,
		CACHE_SERVICE_METHOD.finalize,
		CACHE_SERVICE_METHOD.restore,
	]);
	assert.strictEqual(serviceRequests[2]?.body.key, "plugin-cache-primary");
	assert.deepStrictEqual(serviceRequests[2]?.body.restore_keys, ["plugin-cache-"]);
	assert.strictEqual(serviceRequests[2]?.body.version, serviceRequests[0]?.body.version);
	assert.ok(Number(serviceRequests[1]?.body.size_bytes) > 0);
	assert.ok(blocks.size > 0);
	assert.strictEqual(options.maskSecret.mock.callCount(), 2);
	assert.deepStrictEqual(options.maskSecret.mock.calls[0]?.arguments, [BLOB_URL]);
	assert.deepStrictEqual(options.maskSecret.mock.calls[1]?.arguments, [BLOB_URL]);
});

test("honors cache-mode before executing or requesting anything", async t => {
	const execute = t.mock.fn(async () => {
		throw new Error("should not execute");
	});
	const fetch = t.mock.fn(async () => {
		throw new Error("should not fetch");
	});
	const environment = { [ENVIRONMENT.actionsCacheMode]: CACHE_MODE.none };

	assert.strictEqual(await restoreCache(["cache"], "key", [], { environment, execute, fetch }), undefined);
	assert.strictEqual(await saveCache(["cache"], "key", { environment, execute, fetch }), undefined);
	assert.strictEqual(execute.mock.callCount(), 0);
	assert.strictEqual(fetch.mock.callCount(), 0);
});

for (const status of [408, 429, 503]) {
	test(`retries transient HTTP ${String(status)} cache-service failures`, async t => {
		const responses = [
			Response.json({ msg: "temporary failure" }, { status }),
			Response.json({ ok: false }),
		];
		const fetch = t.mock.fn(async (): Promise<Response> => {
			const response = responses.shift();
			if (response === undefined) throw new Error("Unexpected request");
			return response;
		});
		const execute = t.mock.fn(async () => {});
		const sleep = t.mock.fn(async () => {});
		const debug = t.mock.fn(() => {});
		const environment = cacheServiceEnvironment;

		assert.strictEqual(
			await restoreCache(["cache"], "key", [], { debug, environment, execute, fetch, sleep }),
			undefined,
		);
		assert.strictEqual(fetch.mock.callCount(), 2);
		assert.strictEqual(sleep.mock.callCount(), 1);
		assert.strictEqual(debug.mock.callCount(), 1);
		assert.deepStrictEqual(debug.mock.calls[0]?.arguments, ["Cache request attempt 1/3 failed; retrying"]);
	});
}

test("does not retry cache-service authorization failures", async t => {
	const fetch = t.mock.fn(async () => Response.json({ msg: "cache read denied" }, { status: 403 }));
	const execute = t.mock.fn(async () => {});
	const sleep = t.mock.fn(async () => {});
	const environment = cacheServiceEnvironment;

	await assert.rejects(restoreCache(["cache"], "key", [], { environment, execute, fetch, sleep }), {
		message: "cache read denied",
	});
	assert.strictEqual(fetch.mock.callCount(), 1);
	assert.strictEqual(sleep.mock.callCount(), 0);
});
