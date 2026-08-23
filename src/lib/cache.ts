import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { env as processEnv } from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { debug, setSecret } from "#lib/actions";
import { DPRINT, ENVIRONMENT, RUNTIME_OS } from "#lib/contracts";
import { execFileAsync } from "#lib/exec";
import { GITHUB_API } from "#lib/github";
import { requestWithRetry } from "#lib/http";
import type { RetryTransportOptions } from "#lib/http";
import { createTemporaryDirectory } from "#lib/temp";

const SERVICE = "github.actions.results.api.v1.CacheService";
export const AZURE_STORAGE_API_VERSION = "2021-12-02";
const JSON_MEDIA_TYPE = "application/json";
const VERSION_SALT = "1.0";
const UPLOAD_CHUNK_SIZE = 32 * 1024 * 1024;
const HTTP_HEADER = {
	contentLength: "content-length",
	contentType: "content-type",
	storageVersion: "x-ms-version",
} as const;

export const CACHE_SERVICE_METHOD = {
	create: "CreateCacheEntry",
	finalize: "FinalizeCacheEntryUpload",
	restore: "GetCacheEntryDownloadURL",
} as const;

type Environment = Record<string, string | undefined>;
type Execute = (file: string, args: string[], options?: { cwd?: string }) => Promise<unknown>;

interface CacheOptions extends RetryTransportOptions {
	debug?: (message: string) => void;
	environment?: Environment;
	execute?: Execute;
	maskSecret?: (secret: string) => void;
}

export const CACHE_COMPRESSION = {
	gzip: "gzip",
	zstd: "zstd-without-long",
} as const;

export const CACHE_MODE = {
	none: "none",
	read: "read",
	write: "write",
	writeOnly: "write-only",
} as const;

const CACHE_MODES: readonly string[] = Object.values(CACHE_MODE);

type Compression = typeof CACHE_COMPRESSION[keyof typeof CACHE_COMPRESSION];

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

const environment = (options: CacheOptions): Environment => options.environment ?? processEnv;

const cacheModeAllows = (
	mode: string | undefined,
	operation: typeof CACHE_MODE.read | typeof CACHE_MODE.write,
): boolean => {
	const normalized = mode?.trim().toLowerCase();
	if (normalized === undefined || !CACHE_MODES.includes(normalized)) return true;
	if (operation === CACHE_MODE.read) return normalized === CACHE_MODE.read || normalized === CACHE_MODE.write;
	return normalized === CACHE_MODE.write || normalized === CACHE_MODE.writeOnly;
};

export const isCacheAvailable = (environment: Environment = processEnv): boolean => {
	const server = new URL(environment[ENVIRONMENT.githubServerUrl] ?? GITHUB_API.webUrl).hostname.toUpperCase();
	const githubHosted = server === "GITHUB.COM" || server.endsWith(".GHE.COM") || server.endsWith(".LOCALHOST");
	return githubHosted && environment[ENVIRONMENT.actionsResultsUrl] !== undefined
		&& environment[ENVIRONMENT.actionsRuntimeToken] !== undefined;
};

const validateKeys = (primaryKey: string, restoreKeys: readonly string[] = []): void => {
	const keys = [primaryKey, ...restoreKeys];
	if (keys.length > 10) throw new Error("Cache keys are limited to a maximum of 10");
	for (const key of keys) {
		if (key.length > 512) throw new Error(`Cache key cannot exceed 512 characters: ${key}`);
		if (key.includes(",")) throw new Error(`Cache key cannot contain commas: ${key}`);
	}
};

const compression = async (execute: Execute): Promise<Compression> => {
	if (process.platform === RUNTIME_OS.windows) return CACHE_COMPRESSION.gzip;
	try {
		await execute("zstd", ["--quiet", "--version"]);
		return CACHE_COMPRESSION.zstd;
	} catch {
		return CACHE_COMPRESSION.gzip;
	}
};

export const cacheVersion = (paths: readonly string[], method: Compression): string =>
	createHash(DPRINT.sha256Algorithm).update([...paths, method, VERSION_SALT].join("|")).digest("hex");

const workspace = (environment: Environment): string => environment[ENVIRONMENT.githubWorkspace] ?? process.cwd();

const relativePaths = (paths: readonly string[], environment: Environment): string[] => {
	const root = workspace(environment);
	return paths.map(path => {
		const result = relative(root, path).split(sep).join("/") || ".";
		if (result.includes("\n")) throw new Error(`Cache path cannot contain a newline: ${path}`);
		return result;
	});
};

const tempDirectory = (environment: Environment): Promise<string> =>
	createTemporaryDirectory(environment[ENVIRONMENT.runnerTemporaryDirectory] ?? tmpdir(), "dprint-cache-");

const archiveName = (method: Compression): string => method === CACHE_COMPRESSION.gzip ? "cache.tgz" : "cache.tzst";

const tarCompression = (method: Compression, extract: boolean): string[] => {
	if (method === CACHE_COMPRESSION.gzip) return [extract ? "-xzf" : "-czf"];
	return [extract ? "-xf" : "-cf", "--use-compress-program", extract ? "unzstd" : "zstdmt"];
};

const createArchive = async (
	paths: readonly string[],
	method: Compression,
	directory: string,
	options: CacheOptions,
): Promise<string> => {
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
};

const extractArchive = async (archive: string, method: Compression, options: CacheOptions): Promise<void> => {
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
};

const request = (
	input: string | URL,
	init: RequestInit | undefined,
	options: CacheOptions,
): Promise<Response> =>
	requestWithRetry(input, init, {
		fetch: options.fetch,
		sleep: options.sleep,
		onRetry: (attempt, attempts) =>
			(options.debug ?? debug)(`Cache request attempt ${attempt}/${attempts} failed; retrying`),
	});

const twirp = async <T>(method: string, body: object, options: CacheOptions): Promise<T> => {
	const runtime = environment(options);
	const baseUrl = runtime[ENVIRONMENT.actionsResultsUrl];
	const token = runtime[ENVIRONMENT.actionsRuntimeToken];
	if (baseUrl === undefined || token === undefined) throw new Error("GitHub Actions cache service is unavailable");
	const url = new URL(`/twirp/${SERVICE}/${method}`, baseUrl);
	const response = await request(url, {
		method: "POST",
		headers: {
			accept: JSON_MEDIA_TYPE,
			authorization: `Bearer ${token}`,
			[HTTP_HEADER.contentType]: JSON_MEDIA_TYPE,
		},
		body: JSON.stringify(body),
	}, options);
	const result = await response.json() as T & { msg?: string };
	if (!response.ok) throw new Error(result.msg ?? `Cache service returned HTTP ${response.status}`);
	return result;
};

const download = async (url: string, destination: string, options: CacheOptions): Promise<void> => {
	(options.maskSecret ?? setSecret)(url);
	const response = await request(url, undefined, options);
	if (!response.ok || response.body === null) throw new Error(`Cache download failed with HTTP ${response.status}`);
	await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
};

const uploadBlock = async (url: URL, blockId: string, body: Uint8Array, options: CacheOptions): Promise<void> => {
	const blockUrl = new URL(url);
	blockUrl.searchParams.set("comp", "block");
	blockUrl.searchParams.set("blockid", blockId);
	const response = await request(blockUrl, {
		method: "PUT",
		headers: {
			[HTTP_HEADER.contentLength]: String(body.byteLength),
			[HTTP_HEADER.contentType]: "application/octet-stream",
			[HTTP_HEADER.storageVersion]: url.searchParams.get("sv") ?? AZURE_STORAGE_API_VERSION,
		},
		body,
	}, options);
	if (!response.ok) throw new Error(`Cache block upload failed with HTTP ${response.status}`);
};

const upload = async (urlString: string, archive: string, options: CacheOptions): Promise<void> => {
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
			[HTTP_HEADER.contentLength]: String(Buffer.byteLength(body)),
			[HTTP_HEADER.contentType]: "application/xml",
			[HTTP_HEADER.storageVersion]: url.searchParams.get("sv") ?? AZURE_STORAGE_API_VERSION,
		},
		body,
	}, options);
	if (!response.ok) throw new Error(`Cache block-list upload failed with HTTP ${response.status}`);
};

export const restoreCache = async (
	paths: readonly string[],
	primaryKey: string,
	restoreKeys: readonly string[] = [],
	options: CacheOptions = {},
): Promise<string | undefined> => {
	validateKeys(primaryKey, restoreKeys);
	if (!cacheModeAllows(environment(options)[ENVIRONMENT.actionsCacheMode], CACHE_MODE.read)) return undefined;
	const execute = options.execute ?? execFileAsync;
	const method = await compression(execute);
	const response = await twirp<DownloadResponse>(CACHE_SERVICE_METHOD.restore, {
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
};

export const saveCache = async (paths: readonly string[], key: string, options: CacheOptions = {}): Promise<void> => {
	validateKeys(key);
	if (!cacheModeAllows(environment(options)[ENVIRONMENT.actionsCacheMode], CACHE_MODE.write)) return;
	const execute = options.execute ?? execFileAsync;
	const method = await compression(execute);
	const version = cacheVersion(paths, method);
	const directory = await tempDirectory(environment(options));
	try {
		const archive = await createArchive(paths, method, directory, options);
		const size = (await stat(archive)).size;
		const created = await twirp<CreateResponse>(CACHE_SERVICE_METHOD.create, { key, version }, options);
		const signedUrl = created.signed_upload_url ?? created.signedUploadUrl;
		if (!created.ok || signedUrl === undefined) throw new Error(created.message ?? "Cache reservation failed");
		await upload(signedUrl, archive, options);
		const finalized = await twirp<FinalizeResponse>(CACHE_SERVICE_METHOD.finalize, {
			key,
			size_bytes: String(size),
			version,
		}, options);
		if (!finalized.ok) throw new Error(finalized.message ?? "Cache finalization failed");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};
