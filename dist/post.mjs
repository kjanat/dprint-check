import { createHash } from "node:crypto";
import { EOL, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { env } from "node:process";
import { mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region src/lib/actions.ts
function escapeData(value) {
	return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
function escapeProperty(value) {
	return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}
function command(name, value, properties = {}) {
	const serialized = Object.entries(properties).map(([key, property]) => `${key}=${escapeProperty(property)}`).join(",");
	process.stdout.write(`::${name}${serialized === "" ? "" : ` ${serialized}`}::${escapeData(value)}${EOL}`);
}
function setSecret(secret) {
	command("add-mask", secret);
}
function debug(message) {
	command("debug", message);
}
function info(message) {
	process.stdout.write(`${message}${EOL}`);
}
function warning(message) {
	command("warning", message);
}
function getState(name) {
	return env[`STATE_${name}`] ?? "";
}
//#endregion
//#region src/lib/exec.ts
const execFileAsync = promisify(execFile);
//#endregion
//#region src/lib/cache.ts
const SERVICE = "github.actions.results.api.v1.CacheService";
const VERSION_SALT = "1.0";
const UPLOAD_CHUNK_SIZE = 33554432;
const RETRY_ATTEMPTS = 3;
function environment(options) {
	return options.environment ?? env;
}
function cacheModeAllows(mode, operation) {
	const normalized = mode?.trim().toLowerCase();
	if (normalized === void 0 || ![
		"none",
		"read",
		"write",
		"write-only"
	].includes(normalized)) return true;
	return operation === "read" ? normalized === "read" || normalized === "write" : normalized === "write" || normalized === "write-only";
}
function isCacheAvailable(environment = env) {
	const server = new URL(environment["GITHUB_SERVER_URL"] ?? "https://github.com").hostname.toUpperCase();
	return (server === "GITHUB.COM" || server.endsWith(".GHE.COM") || server.endsWith(".LOCALHOST")) && environment["ACTIONS_RESULTS_URL"] !== void 0 && environment["ACTIONS_RUNTIME_TOKEN"] !== void 0;
}
function validateKeys(primaryKey, restoreKeys = []) {
	const keys = [primaryKey, ...restoreKeys];
	if (keys.length > 10) throw new Error("Cache keys are limited to a maximum of 10");
	for (const key of keys) {
		if (key.length > 512) throw new Error(`Cache key cannot exceed 512 characters: ${key}`);
		if (key.includes(",")) throw new Error(`Cache key cannot contain commas: ${key}`);
	}
}
async function compression(execute) {
	if (process.platform === "win32") return "gzip";
	try {
		await execute("zstd", ["--quiet", "--version"]);
		return "zstd-without-long";
	} catch {
		return "gzip";
	}
}
function cacheVersion(paths, method) {
	return createHash("sha256").update([
		...paths,
		method,
		VERSION_SALT
	].join("|")).digest("hex");
}
function workspace(environment) {
	return environment["GITHUB_WORKSPACE"] ?? process.cwd();
}
function relativePaths(paths, environment) {
	const root = workspace(environment);
	return paths.map((path) => {
		const result = relative(root, path).split(sep).join("/") || ".";
		if (result.includes("\n")) throw new Error(`Cache path cannot contain a newline: ${path}`);
		return result;
	});
}
async function tempDirectory(environment) {
	const root = environment["RUNNER_TEMP"] ?? tmpdir();
	await mkdir(root, { recursive: true });
	return await mkdtemp(join(root, "dprint-cache-"));
}
function archiveName(method) {
	return method === "gzip" ? "cache.tgz" : "cache.tzst";
}
function tarCompression(method, extract) {
	if (method === "gzip") return [extract ? "-xzf" : "-czf"];
	return [
		extract ? "-xf" : "-cf",
		"--use-compress-program",
		extract ? "unzstd" : "zstdmt"
	];
}
async function createArchive(paths, method, directory, options) {
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
}
async function sleep(milliseconds) {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function request(input, init, options) {
	const fetch = options.fetch ?? globalThis.fetch;
	let lastError;
	let lastResponse;
	for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
		try {
			const response = await fetch(input, init);
			if (response.ok || response.status < 500 && response.status !== 429) return response;
			lastResponse = response;
			lastError = /* @__PURE__ */ new Error(`HTTP ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		if (attempt < RETRY_ATTEMPTS) {
			(options.debug ?? debug)(`Cache request attempt ${attempt}/${RETRY_ATTEMPTS} failed; retrying`);
			await (options.sleep ?? sleep)(attempt * 1e3);
		}
	}
	if (lastResponse !== void 0) return lastResponse;
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
async function twirp(method, body, options) {
	const runtime = environment(options);
	const baseUrl = runtime["ACTIONS_RESULTS_URL"];
	const token = runtime["ACTIONS_RUNTIME_TOKEN"];
	if (baseUrl === void 0 || token === void 0) throw new Error("GitHub Actions cache service is unavailable");
	const response = await request(new URL(`/twirp/${SERVICE}/${method}`, baseUrl), {
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
}
async function uploadBlock(url, blockId, body, options) {
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
}
async function upload(urlString, archive, options) {
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
}
async function saveCache(paths, key, options = {}) {
	validateKeys(key);
	if (!cacheModeAllows(environment(options)["ACTIONS_CACHE_MODE"], "write")) return;
	const method = await compression(options.execute ?? execFileAsync);
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
}
//#endregion
//#region src/post.ts
async function save(paths, key, label) {
	info(`Saving ${label}: ${paths.join(", ")} -> ${key}`);
	try {
		await saveCache(paths, key);
		info(`${label} saved`);
	} catch (error) {
		if (error instanceof Error && error.message.includes("already exists")) info(`${label} entry already exists`);
		else throw error;
	}
}
async function post() {
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
		warning(`Cache save failed: ${describe(error)}`);
	}
}
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}
post();
//#endregion
export {};
