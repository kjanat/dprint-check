import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { env as processEnv } from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { debug, setSecret } from "#lib/actions";
import { execFileAsync } from "#lib/exec";

const SERVICE = "github.actions.results.api.v1.CacheService";
const VERSION_SALT = "1.0";
const UPLOAD_CHUNK_SIZE = 32 * 1024 * 1024;
const RETRY_ATTEMPTS = 3;

type Environment = Record<string, string | undefined>;
type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Execute = (file: string, args: string[], options?: { cwd?: string }) => Promise<unknown>;

interface CacheOptions {
	debug?: (message: string) => void;
	environment?: Environment;
	fetch?: Fetch;
	execute?: Execute;
	maskSecret?: (secret: string) => void;
	sleep?: (milliseconds: number) => Promise<void>;
}

type Compression = "gzip" | "zstd-without-long";

interface DownloadResponse {
	ok: boolean;
	signed_download_url?: string;
	signedDownloadUrl?: string;
	matched_key?: string;
	matchedKey?: string;
}

interface CreateResponse {
	ok: boolean;
	signed_upload_url?: string;
	signedUploadUrl?: string;
	message?: string;
}

interface FinalizeResponse {
	ok: boolean;
	message?: string;
}

function environment(options: CacheOptions): Environment {
	return options.environment ?? processEnv;
}

function cacheModeAllows(mode: string | undefined, operation: "read" | "write"): boolean {
	const normalized = mode?.trim().toLowerCase();
	if (normalized === undefined || !["none", "read", "write", "write-only"].includes(normalized)) return true;
	return operation === "read"
		? normalized === "read" || normalized === "write"
		: normalized === "write" || normalized === "write-only";
}

export function isCacheAvailable(environment: Environment = processEnv): boolean {
	const server = new URL(environment["GITHUB_SERVER_URL"] ?? "https://github.com").hostname.toUpperCase();
	const githubHosted = server === "GITHUB.COM" || server.endsWith(".GHE.COM") || server.endsWith(".LOCALHOST");
	return githubHosted && environment["ACTIONS_RESULTS_URL"] !== undefined
		&& environment["ACTIONS_RUNTIME_TOKEN"] !== undefined;
}

function validateKeys(primaryKey: string, restoreKeys: readonly string[] = []): void {
	const keys = [primaryKey, ...restoreKeys];
	if (keys.length > 10) throw new Error("Cache keys are limited to a maximum of 10");
	for (const key of keys) {
		if (key.length > 512) throw new Error(`Cache key cannot exceed 512 characters: ${key}`);
		if (key.includes(",")) throw new Error(`Cache key cannot contain commas: ${key}`);
	}
}

async function compression(execute: Execute): Promise<Compression> {
	if (process.platform === "win32") return "gzip";
	try {
		await execute("zstd", ["--quiet", "--version"]);
		return "zstd-without-long";
	} catch {
		return "gzip";
	}
}

export function cacheVersion(paths: readonly string[], method: Compression): string {
	return createHash("sha256").update([...paths, method, VERSION_SALT].join("|")).digest("hex");
}

function workspace(environment: Environment): string {
	return environment["GITHUB_WORKSPACE"] ?? process.cwd();
}

function relativePaths(paths: readonly string[], environment: Environment): string[] {
	const root = workspace(environment);
	return paths.map(path => {
		const result = relative(root, path).split(sep).join("/") || ".";
		if (result.includes("\n")) throw new Error(`Cache path cannot contain a newline: ${path}`);
		return result;
	});
}

async function tempDirectory(environment: Environment): Promise<string> {
	const root = environment["RUNNER_TEMP"] ?? tmpdir();
	await mkdir(root, { recursive: true });
	return await mkdtemp(join(root, "dprint-cache-"));
}

function archiveName(method: Compression): string {
	return method === "gzip" ? "cache.tgz" : "cache.tzst";
}

function tarCompression(method: Compression, extract: boolean): string[] {
	if (method === "gzip") return [extract ? "-xzf" : "-czf"];
	return [extract ? "-xf" : "-cf", "--use-compress-program", extract ? "unzstd" : "zstdmt"];
}

async function createArchive(
	paths: readonly string[],
	method: Compression,
	directory: string,
	options: CacheOptions,
): Promise<string> {
	for (const path of paths) await stat(path);
	const manifest = join(directory, "manifest.txt");
	await writeFile(manifest, relativePaths(paths, environment(options)).join("\n"));
	const archive = join(directory, archiveName(method));
	const [operation, ...compressionArgs] = tarCompression(method, false);
	await (options.execute ?? execFileAsync)("tar", [
		operation ?? "-czf",
		archive,
		...compressionArgs,
		"-P",
		"-C",
		workspace(environment(options)),
		"-T",
		manifest,
	], { cwd: directory });
	return archive;
}

async function extractArchive(archive: string, method: Compression, options: CacheOptions): Promise<void> {
	await mkdir(workspace(environment(options)), { recursive: true });
	const [operation, ...compressionArgs] = tarCompression(method, true);
	await (options.execute ?? execFileAsync)("tar", [
		operation ?? "-xzf",
		archive,
		...compressionArgs,
		"-P",
		"-C",
		workspace(environment(options)),
	]);
}

async function sleep(milliseconds: number): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function request(input: string | URL, init: RequestInit | undefined, options: CacheOptions): Promise<Response> {
	const fetch = options.fetch ?? globalThis.fetch;
	let lastError: unknown;
	let lastResponse: Response | undefined;
	for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
		try {
			const response = await fetch(input, init);
			if (response.ok || response.status < 500 && response.status !== 429) return response;
			lastResponse = response;
			lastError = new Error(`HTTP ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		if (attempt < RETRY_ATTEMPTS) {
			(options.debug ?? debug)(`Cache request attempt ${attempt}/${RETRY_ATTEMPTS} failed; retrying`);
			await (options.sleep ?? sleep)(attempt * 1000);
		}
	}
	if (lastResponse !== undefined) return lastResponse;
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function twirp<T>(method: string, body: object, options: CacheOptions): Promise<T> {
	const runtime = environment(options);
	const baseUrl = runtime["ACTIONS_RESULTS_URL"];
	const token = runtime["ACTIONS_RUNTIME_TOKEN"];
	if (baseUrl === undefined || token === undefined) throw new Error("GitHub Actions cache service is unavailable");
	const url = new URL(`/twirp/${SERVICE}/${method}`, baseUrl);
	const response = await request(url, {
		method: "POST",
		headers: {
			accept: "application/json",
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	}, options);
	const result = await response.json() as T & { msg?: string };
	if (!response.ok) throw new Error(result.msg ?? `Cache service returned HTTP ${response.status}`);
	return result;
}

async function download(url: string, destination: string, options: CacheOptions): Promise<void> {
	(options.maskSecret ?? setSecret)(url);
	const response = await request(url, undefined, options);
	if (!response.ok || response.body === null) throw new Error(`Cache download failed with HTTP ${response.status}`);
	await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
}

async function uploadBlock(url: URL, blockId: string, body: Uint8Array, options: CacheOptions): Promise<void> {
	const blockUrl = new URL(url);
	blockUrl.searchParams.set("comp", "block");
	blockUrl.searchParams.set("blockid", blockId);
	const response = await request(blockUrl, {
		method: "PUT",
		headers: {
			"content-length": String(body.byteLength),
			"content-type": "application/octet-stream",
			"x-ms-version": url.searchParams.get("sv") ?? "2021-12-02",
		},
		body,
	}, options);
	if (!response.ok) throw new Error(`Cache block upload failed with HTTP ${response.status}`);
}

async function upload(urlString: string, archive: string, options: CacheOptions): Promise<void> {
	(options.maskSecret ?? setSecret)(urlString);
	const url = new URL(urlString);
	const file = await open(archive, "r");
	const blockIds: string[] = [];
	try {
		const size = (await file.stat()).size;
		for (let offset = 0, index = 0; offset < size; offset += UPLOAD_CHUNK_SIZE, index++) {
			const length = Math.min(UPLOAD_CHUNK_SIZE, size - offset);
			const buffer = Buffer.allocUnsafe(length);
			const { bytesRead } = await file.read(buffer, 0, length, offset);
			const blockId = Buffer.from(index.toString().padStart(8, "0")).toString("base64");
			blockIds.push(blockId);
			await uploadBlock(url, blockId, buffer.subarray(0, bytesRead), options);
		}
	} finally {
		await file.close();
	}

	const blockListUrl = new URL(url);
	blockListUrl.searchParams.set("comp", "blocklist");
	const body = `<?xml version="1.0" encoding="utf-8"?><BlockList>${
		blockIds.map(id => `<Latest>${id}</Latest>`).join("")
	}</BlockList>`;
	const response = await request(blockListUrl, {
		method: "PUT",
		headers: {
			"content-length": String(Buffer.byteLength(body)),
			"content-type": "application/xml",
			"x-ms-version": url.searchParams.get("sv") ?? "2021-12-02",
		},
		body,
	}, options);
	if (!response.ok) throw new Error(`Cache block-list upload failed with HTTP ${response.status}`);
}

export async function restoreCache(
	paths: readonly string[],
	primaryKey: string,
	restoreKeys: readonly string[] = [],
	options: CacheOptions = {},
): Promise<string | undefined> {
	validateKeys(primaryKey, restoreKeys);
	if (!cacheModeAllows(environment(options)["ACTIONS_CACHE_MODE"], "read")) return undefined;
	const execute = options.execute ?? execFileAsync;
	const method = await compression(execute);
	const response = await twirp<DownloadResponse>("GetCacheEntryDownloadURL", {
		key: primaryKey,
		restore_keys: restoreKeys,
		version: cacheVersion(paths, method),
	}, options);
	if (!response.ok) return undefined;
	const signedUrl = response.signed_download_url ?? response.signedDownloadUrl;
	const matchedKey = response.matched_key ?? response.matchedKey;
	if (signedUrl === undefined || matchedKey === undefined) {
		throw new Error("Cache service returned an invalid download response");
	}

	const directory = await tempDirectory(environment(options));
	const archive = join(directory, archiveName(method));
	try {
		(options.debug ?? debug)(`Downloading cache archive for ${matchedKey}`);
		await download(signedUrl, archive, options);
		await extractArchive(archive, method, options);
		return matchedKey;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function saveCache(paths: readonly string[], key: string, options: CacheOptions = {}): Promise<void> {
	validateKeys(key);
	if (!cacheModeAllows(environment(options)["ACTIONS_CACHE_MODE"], "write")) return;
	const execute = options.execute ?? execFileAsync;
	const method = await compression(execute);
	const version = cacheVersion(paths, method);
	const directory = await tempDirectory(environment(options));
	try {
		const archive = await createArchive(paths, method, directory, options);
		const size = (await stat(archive)).size;
		const created = await twirp<CreateResponse>("CreateCacheEntry", { key, version }, options);
		const signedUrl = created.signed_upload_url ?? created.signedUploadUrl;
		if (!created.ok || signedUrl === undefined) throw new Error(created.message ?? "Cache reservation failed");
		await upload(signedUrl, archive, options);
		const finalized = await twirp<FinalizeResponse>("FinalizeCacheEntryUpload", {
			key,
			size_bytes: String(size),
			version,
		}, options);
		if (!finalized.ok) throw new Error(finalized.message ?? "Cache finalization failed");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
