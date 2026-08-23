import { createHash } from "node:crypto";
import { EOL, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { env } from "node:process";
import { mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region src/lib/actions.ts
const escapeData = (value) => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (value) => escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
const command = (name, value, properties = {}) => {
	const serialized = Object.entries(properties).map(([key, property]) => `${key}=${escapeProperty(property)}`).join(",");
	process.stdout.write(`::${name}${serialized === "" ? "" : ` ${serialized}`}::${escapeData(value)}${EOL}`);
};
const setSecret = (secret) => command("add-mask", secret);
const debug = (message) => command("debug", message);
const info = (message) => void process.stdout.write(`${message}${EOL}`);
const warning = (message) => command("warning", message);
const getState = (name) => env[`STATE_${name}`] ?? "";
//#endregion
//#region src/lib/exec.ts
const execFileAsync = promisify(execFile);
//#endregion
//#region src/lib/http.ts
const isRetryableStatus = (status) => status === 408 || status === 429 || status >= 500;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const requestWithRetry = async (input, init, options = {}) => {
	const attempts = options.attempts ?? 3;
	const fetch = options.fetch ?? globalThis.fetch;
	let lastError;
	let lastResponse;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const response = await fetch(input, init);
			if (response.ok || !isRetryableStatus(response.status)) return response;
			lastResponse = response;
			lastError = /* @__PURE__ */ new Error(`HTTP ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		if (attempt < attempts) {
			options.onRetry?.(attempt, attempts);
			await (options.sleep ?? sleep)(attempt * 1e3);
		}
	}
	if (lastResponse !== void 0) return lastResponse;
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
};
//#endregion
//#region src/lib/temp.ts
const createTemporaryDirectory = async (root, prefix) => {
	await mkdir(root, { recursive: true });
	return mkdtemp(join(root, prefix));
};
//#endregion
//#region src/lib/cache.ts
const SERVICE = "github.actions.results.api.v1.CacheService";
const VERSION_SALT = "1.0";
const UPLOAD_CHUNK_SIZE = 33554432;
const environment = (options) => options.environment ?? env;
const cacheModeAllows = (mode, operation) => {
	const normalized = mode?.trim().toLowerCase();
	if (normalized === void 0 || ![
		"none",
		"read",
		"write",
		"write-only"
	].includes(normalized)) return true;
	return operation === "read" ? normalized === "read" || normalized === "write" : normalized === "write" || normalized === "write-only";
};
const isCacheAvailable = (environment = env) => {
	const server = new URL(environment["GITHUB_SERVER_URL"] ?? "https://github.com").hostname.toUpperCase();
	return (server === "GITHUB.COM" || server.endsWith(".GHE.COM") || server.endsWith(".LOCALHOST")) && environment["ACTIONS_RESULTS_URL"] !== void 0 && environment["ACTIONS_RUNTIME_TOKEN"] !== void 0;
};
const validateKeys = (primaryKey, restoreKeys = []) => {
	const keys = [primaryKey, ...restoreKeys];
	if (keys.length > 10) throw new Error("Cache keys are limited to a maximum of 10");
	for (const key of keys) {
		if (key.length > 512) throw new Error(`Cache key cannot exceed 512 characters: ${key}`);
		if (key.includes(",")) throw new Error(`Cache key cannot contain commas: ${key}`);
	}
};
const compression = async (execute) => {
	if (process.platform === "win32") return "gzip";
	try {
		await execute("zstd", ["--quiet", "--version"]);
		return "zstd-without-long";
	} catch {
		return "gzip";
	}
};
const cacheVersion = (paths, method) => createHash("sha256").update([
	...paths,
	method,
	VERSION_SALT
].join("|")).digest("hex");
const workspace = (environment) => environment["GITHUB_WORKSPACE"] ?? process.cwd();
const relativePaths = (paths, environment) => {
	const root = workspace(environment);
	return paths.map((path) => {
		const result = relative(root, path).split(sep).join("/") || ".";
		if (result.includes("\n")) throw new Error(`Cache path cannot contain a newline: ${path}`);
		return result;
	});
};
const tempDirectory = (environment) => createTemporaryDirectory(environment["RUNNER_TEMP"] ?? tmpdir(), "dprint-cache-");
const archiveName = (method) => method === "gzip" ? "cache.tgz" : "cache.tzst";
const tarCompression = (method, extract) => {
	if (method === "gzip") return [extract ? "-xzf" : "-czf"];
	return [
		extract ? "-xf" : "-cf",
		"--use-compress-program",
		extract ? "unzstd" : "zstdmt"
	];
};
const createArchive = async (paths, method, directory, options) => {
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
		manifest
	], { cwd: directory });
	return archive;
};
const request = (input, init, options) => requestWithRetry(input, init, {
	fetch: options.fetch,
	sleep: options.sleep,
	onRetry: (attempt, attempts) => (options.debug ?? debug)(`Cache request attempt ${attempt}/${attempts} failed; retrying`)
});
const twirp = async (method, body, options) => {
	const runtime = environment(options);
	const baseUrl = runtime["ACTIONS_RESULTS_URL"];
	const token = runtime["ACTIONS_RUNTIME_TOKEN"];
	if (baseUrl === void 0 || token === void 0) throw new Error("GitHub Actions cache service is unavailable");
	const url = new URL(`/twirp/${SERVICE}/${method}`, baseUrl);
	const response = await request(url, {
		method: "POST",
		headers: {
			accept: "application/json",
			authorization: `Bearer ${token}`,
			"content-type": "application/json"
		},
		body: JSON.stringify(body)
	}, options);
	const result = await response.json();
	if (!response.ok) throw new Error(result.msg ?? `Cache service returned HTTP ${response.status}`);
	return result;
};
const uploadBlock = async (url, blockId, body, options) => {
	const blockUrl = new URL(url);
	blockUrl.searchParams.set("comp", "block");
	blockUrl.searchParams.set("blockid", blockId);
	const response = await request(blockUrl, {
		method: "PUT",
		headers: {
			"content-length": String(body.byteLength),
			"content-type": "application/octet-stream",
			"x-ms-version": url.searchParams.get("sv") ?? "2021-12-02"
		},
		body
	}, options);
	if (!response.ok) throw new Error(`Cache block upload failed with HTTP ${response.status}`);
};
const upload = async (urlString, archive, options) => {
	(options.maskSecret ?? setSecret)(urlString);
	const url = new URL(urlString);
	const file = await open(archive, "r");
	const blockIds = [];
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
	const body = `<?xml version="1.0" encoding="utf-8"?><BlockList>${blockIds.map((id) => `<Latest>${id}</Latest>`).join("")}</BlockList>`;
	const response = await request(blockListUrl, {
		method: "PUT",
		headers: {
			"content-length": String(Buffer.byteLength(body)),
			"content-type": "application/xml",
			"x-ms-version": url.searchParams.get("sv") ?? "2021-12-02"
		},
		body
	}, options);
	if (!response.ok) throw new Error(`Cache block-list upload failed with HTTP ${response.status}`);
};
const saveCache = async (paths, key, options = {}) => {
	validateKeys(key);
	if (!cacheModeAllows(environment(options)["ACTIONS_CACHE_MODE"], "write")) return;
	const execute = options.execute ?? execFileAsync;
	const method = await compression(execute);
	const version = cacheVersion(paths, method);
	const directory = await tempDirectory(environment(options));
	try {
		const archive = await createArchive(paths, method, directory, options);
		const size = (await stat(archive)).size;
		const created = await twirp("CreateCacheEntry", {
			key,
			version
		}, options);
		const signedUrl = created.signed_upload_url ?? created.signedUploadUrl;
		if (!created.ok || signedUrl === void 0) throw new Error(created.message ?? "Cache reservation failed");
		await upload(signedUrl, archive, options);
		const finalized = await twirp("FinalizeCacheEntryUpload", {
			key,
			size_bytes: String(size),
			version
		}, options);
		if (!finalized.ok) throw new Error(finalized.message ?? "Cache finalization failed");
	} finally {
		await rm(directory, {
			recursive: true,
			force: true
		});
	}
};
//#endregion
//#region src/lib/error.ts
const describeError = (error) => error instanceof Error ? error.message : String(error);
//#endregion
//#region src/post.ts
const save = async (paths, key, label) => {
	info(`Saving ${label}: ${paths.join(", ")} -> ${key}`);
	try {
		await saveCache(paths, key);
		info(`${label} saved`);
	} catch (error) {
		if (error instanceof Error && error.message.includes("already exists")) info(`${label} entry already exists`);
		else throw error;
	}
};
const post = async () => {
	if (!isCacheAvailable()) {
		info("GitHub Actions cache is unavailable; nothing to save");
		return;
	}
	try {
		const binaryKey = getState("BIN_CACHE_KEY");
		const binaryDir = getState("BIN_CACHE_DIR");
		debug(`Post binary cache state: key=${binaryKey || "none"}; directory=${binaryDir || "none"}`);
		if (binaryKey !== "" && binaryDir !== "") await save([binaryDir], binaryKey, "dprint binary cache");
		const pluginKey = getState("PLUGIN_CACHE_KEY");
		const pluginDir = getState("PLUGIN_CACHE_DIR");
		debug(`Post plugin cache state: key=${pluginKey || "none"}; directory=${pluginDir || "none"}`);
		if (pluginKey === "" || pluginDir === "") {
			info("No plugin cache to save");
			return;
		}
		if (getState("PLUGIN_CACHE_EXACT_HIT") === "true") {
			info("Plugin cache already up to date");
			return;
		}
		if (getState("PLUGIN_CACHE_READY") !== "true") {
			info("Plugin cache warmup did not complete; skipping cache save");
			return;
		}
		await save([pluginDir], pluginKey, "dprint plugin cache");
	} catch (error) {
		warning(`Cache save failed: ${describeError(error)}`);
	}
};
post();
//#endregion
export {};
