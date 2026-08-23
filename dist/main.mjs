import { createRequire } from "node:module";
import { EOL, arch, endianness, homedir, platform, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { cwd, env } from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { cp, glob, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region \0rolldown/runtime.js
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
//#endregion
//#region src/lib/actions.ts
const escapeData = (value) => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (value) => escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
const command = (name, value, properties = {}) => {
	const serialized = Object.entries(properties).map(([key, property]) => `${key}=${escapeProperty(property)}`).join(",");
	process.stdout.write(`::${name}${serialized === "" ? "" : ` ${serialized}`}::${escapeData(value)}${EOL}`);
};
const fileCommand = (variable, name, value) => {
	const path = env[variable];
	if (path === void 0 || path === "") return false;
	const marker = `dprint_${randomUUID()}`;
	if (value.includes(marker)) throw new Error(`Unable to write ${name}: value contains generated delimiter`);
	appendFileSync(path, `${name}<<${marker}${EOL}${value}${EOL}${marker}${EOL}`, { encoding: "utf8" });
	return true;
};
const getInput = (name, options = {}) => {
	const value = env[`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`] ?? "";
	return options.trimWhitespace === false ? value : value.trim();
};
const setSecret = (secret) => command("add-mask", secret);
const debug = (message) => command("debug", message);
const info = (message) => void process.stdout.write(`${message}${EOL}`);
const warning = (message) => command("warning", message);
const setFailed = (message) => {
	process.exitCode = 1;
	command("error", message);
};
const setOutput = (name, value) => {
	const serialized = String(value);
	if (!fileCommand("GITHUB_OUTPUT", name, serialized)) command("set-output", serialized, { name });
};
const saveState = (name, value) => {
	if (!fileCommand("GITHUB_STATE", name, value)) command("save-state", value, { name });
};
const exportVariable = (name, value) => {
	env[name] = value;
	if (!fileCommand("GITHUB_ENV", name, value)) command("set-env", value, { name });
};
const addPath = (path) => {
	env["PATH"] = `${path}${delimiter}${env["PATH"] ?? ""}`;
	const file = env["GITHUB_PATH"];
	if (file !== void 0 && file !== "") appendFileSync(file, `${path}${EOL}`, { encoding: "utf8" });
	else command("add-path", path);
};
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
const extractArchive = async (archive, method, options) => {
	await mkdir(workspace(environment(options)), { recursive: true });
	const [operation, ...compressionArgs] = tarCompression(method, true);
	await (options.execute ?? execFileAsync)("tar", [
		operation ?? "-xzf",
		archive,
		...compressionArgs,
		"-P",
		"-C",
		workspace(environment(options))
	]);
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
const download = async (url, destination, options) => {
	(options.maskSecret ?? setSecret)(url);
	const response = await request(url, void 0, options);
	if (!response.ok || response.body === null) throw new Error(`Cache download failed with HTTP ${response.status}`);
	await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
};
const restoreCache = async (paths, primaryKey, restoreKeys = [], options = {}) => {
	validateKeys(primaryKey, restoreKeys);
	if (!cacheModeAllows(environment(options)["ACTIONS_CACHE_MODE"], "read")) return void 0;
	const execute = options.execute ?? execFileAsync;
	const method = await compression(execute);
	const response = await twirp("GetCacheEntryDownloadURL", {
		key: primaryKey,
		restore_keys: restoreKeys,
		version: cacheVersion(paths, method)
	}, options);
	if (!response.ok) return void 0;
	const signedUrl = response.signed_download_url ?? response.signedDownloadUrl;
	const matchedKey = response.matched_key ?? response.matchedKey;
	if (signedUrl === void 0 || matchedKey === void 0) throw new Error("Cache service returned an invalid download response");
	const directory = await tempDirectory(environment(options));
	const archive = join(directory, archiveName(method));
	try {
		(options.debug ?? debug)(`Downloading cache archive for ${matchedKey}`);
		await download(signedUrl, archive, options);
		await extractArchive(archive, method, options);
		return matchedKey;
	} finally {
		await rm(directory, {
			recursive: true,
			force: true
		});
	}
};
//#endregion
//#region src/lib/check.ts
const parseArgs = (input) => {
	const args = [];
	let current = "";
	let quote;
	let escaped = false;
	let started = false;
	for (const character of input) {
		if (escaped) {
			if (character !== "\"" && character !== "\\") current += "\\";
			current += character;
			escaped = false;
			continue;
		}
		if (quote === "\"" && character === "\\") {
			escaped = true;
			continue;
		}
		if (quote !== void 0) {
			if (character === quote) quote = void 0;
			else current += character;
			continue;
		}
		if (character === "\"" || character === "'") {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/u.test(character)) {
			if (started) {
				args.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += character;
		started = true;
	}
	if (escaped) current += "\\";
	if (quote !== void 0) throw new Error("Unterminated quote in args input");
	if (started) args.push(current);
	return args;
};
const buildCheckArgs = (configPath, additionalArgs) => {
	const args = ["check"];
	if (configPath !== "") args.push("--config", configPath);
	if (additionalArgs.trim() !== "") args.push(...parseArgs(additionalArgs));
	return args;
};
const checkFormatting = async (binaryPath, configPath, additionalArgs, execute = execFileAsync) => {
	await execute(binaryPath, buildCheckArgs(configPath, additionalArgs));
};
//#endregion
//#region src/lib/config.ts
const CONFIG_NAMES = [
	"dprint.json",
	"dprint.jsonc",
	".dprint.json",
	".dprint.jsonc"
];
const workspacePath = () => env["GITHUB_WORKSPACE"] ?? cwd();
const findConfigFiles = async (customPath) => {
	const workspace = workspacePath();
	if (customPath !== void 0 && customPath.trim() !== "") {
		const pattern = isAbsolute(customPath) ? customPath : join(workspace, customPath);
		return (await Array.fromAsync(glob(pattern))).sort();
	}
	const matches = (await Array.fromAsync(glob(CONFIG_NAMES.map((name) => join(workspace, "**", name)), { exclude: [join(workspace, "**", "node_modules", "**"), join(workspace, "**", ".git", "**")] }))).sort();
	for (const name of CONFIG_NAMES) {
		const rootCandidate = join(workspace, name);
		if (matches.includes(rootCandidate)) return [rootCandidate, ...matches.filter((match) => match !== rootCandidate)];
	}
	return matches;
};
const computeCacheKey = (configPaths, dprintVersion, platformKey) => {
	const workspace = workspacePath();
	const hash = createHash("sha256");
	for (const configPath of [...configPaths].sort()) {
		const stablePath = relative(workspace, configPath).split(sep).join("/");
		hash.update(stablePath);
		hash.update("\0");
		hash.update(readFileSync(configPath));
		hash.update("\0");
	}
	const digest = hash.digest("hex");
	const platformPrefix = `dprint-plugins-v2-${platformKey}`;
	const prefix = `${platformPrefix}-${dprintVersion}`;
	return {
		primaryKey: `${prefix}-${digest}`,
		restoreKeys: [`${prefix}-`, `${platformPrefix}-`]
	};
};
//#endregion
//#region src/lib/error.ts
const describeError = (error) => error instanceof Error ? error.message : String(error);
//#endregion
//#region src/lib/tool.ts
const temporaryRoot = () => env["RUNNER_TEMP"] ?? tmpdir();
const temporaryDirectory = (prefix) => createTemporaryDirectory(temporaryRoot(), prefix);
const toolPath = (tool, version, architecture) => {
	const root = env["RUNNER_TOOL_CACHE"];
	return root === void 0 || root === "" ? void 0 : join(root, tool, version, architecture);
};
const findTool = (tool, version, architecture) => {
	const path = toolPath(tool, version, architecture);
	if (path !== void 0 && existsSync(path) && existsSync(`${path}.complete`)) return path;
	return "";
};
const cacheToolDirectory = async (sourceDirectory, tool, version, architecture) => {
	const destination = toolPath(tool, version, architecture);
	if (destination === void 0) {
		debug("RUNNER_TOOL_CACHE is unavailable; skipping tool-cache storage");
		return "";
	}
	await rm(destination, {
		recursive: true,
		force: true
	});
	await rm(`${destination}.complete`, { force: true });
	await mkdir(destination, { recursive: true });
	for (const entry of await readdir(sourceDirectory)) await cp(join(sourceDirectory, entry), join(destination, entry), { recursive: true });
	await writeFile(`${destination}.complete`, "");
	return destination;
};
const downloadTool = async (url, options = {}) => {
	const directory = await temporaryDirectory("dprint-download-");
	const destination = join(directory, "download");
	try {
		const response = await requestWithRetry(url, void 0, options);
		if (!response.ok || response.body === null) throw new Error(`Download failed with HTTP ${response.status}`);
		await mkdir(dirname(destination), { recursive: true });
		await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
		return destination;
	} catch (error) {
		await rm(directory, {
			recursive: true,
			force: true
		});
		throw error;
	}
};
const powershellLiteral = (value) => `'${value.replaceAll("'", "''").replace(/["\r\n]/gu, "")}'`;
const extractZip = async (archive) => {
	const destination = await temporaryDirectory("dprint-extract-");
	if (process.platform === "win32") {
		const command = `Expand-Archive -LiteralPath ${powershellLiteral(archive)} -DestinationPath ${powershellLiteral(destination)} -Force`;
		try {
			await execFileAsync("pwsh", [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				command
			]);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			await execFileAsync("powershell", [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				command
			]);
		}
	} else await execFileAsync("unzip", [
		"-o",
		"-q",
		archive,
		"-d",
		destination
	]);
	return destination;
};
//#endregion
//#region src/lib/checksum.ts
const digestFromAsset = (asset) => {
	return (asset.digest?.match(/^sha256:([0-9a-f]{64})$/iu))?.[1]?.toLowerCase();
};
const checksumFromManifest = (manifest, assetName) => {
	for (const line of manifest.split(/\r?\n/u)) {
		const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/iu);
		if (match?.[2] === assetName) return match[1]?.toLowerCase();
	}
};
const resolveReleaseAssetChecksum = async (releaseTag, asset, assets, download = downloadTool) => {
	const digest = digestFromAsset(asset);
	if (digest !== void 0) return digest;
	const manifestAsset = assets.find((candidate) => candidate.name === "SHASUMS256.txt");
	if (manifestAsset === void 0) throw new Error(`dprint ${releaseTag} cannot be securely installed: the release provides neither a SHA-256 digest for ${asset.name} nor SHASUMS256.txt`);
	const manifestPath = await download(manifestAsset.browser_download_url);
	const checksum = checksumFromManifest(await readFile(manifestPath, "utf8"), asset.name);
	if (checksum === void 0) throw new Error(`dprint ${releaseTag} cannot be securely installed: SHASUMS256.txt has no checksum for ${asset.name}`);
	return checksum;
};
const sha256 = async (path) => {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
};
const verifyReleaseAsset = async (archivePath, asset, expectedChecksum) => {
	const actual = await sha256(archivePath);
	if (actual !== expectedChecksum) throw new Error(`SHA-256 mismatch for ${asset.name}: expected ${expectedChecksum}, got ${actual}`);
};
//#endregion
//#region node_modules/detect-libc/lib/process.js
var require_process = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const isLinux = () => process.platform === "linux";
	let report = null;
	const getReport = () => {
		if (!report) {
			/* istanbul ignore next */
			if (isLinux() && process.report) {
				const orig = process.report.excludeNetwork;
				process.report.excludeNetwork = true;
				report = process.report.getReport();
				process.report.excludeNetwork = orig;
			} else report = {};
		}
		return report;
	};
	module.exports = {
		isLinux,
		getReport
	};
}));
//#endregion
//#region node_modules/detect-libc/lib/filesystem.js
var require_filesystem = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const fs = __require("fs");
	const LDD_PATH = "/usr/bin/ldd";
	const SELF_PATH = "/proc/self/exe";
	const MAX_LENGTH = 2048;
	/**
	* Read the content of a file synchronous
	*
	* @param {string} path
	* @returns {Buffer}
	*/
	const readFileSync = (path) => {
		const fd = fs.openSync(path, "r");
		const buffer = Buffer.alloc(MAX_LENGTH);
		const bytesRead = fs.readSync(fd, buffer, 0, MAX_LENGTH, 0);
		fs.close(fd, () => {});
		return buffer.subarray(0, bytesRead);
	};
	/**
	* Read the content of a file
	*
	* @param {string} path
	* @returns {Promise<Buffer>}
	*/
	const readFile = (path) => new Promise((resolve, reject) => {
		fs.open(path, "r", (err, fd) => {
			if (err) reject(err);
			else {
				const buffer = Buffer.alloc(MAX_LENGTH);
				fs.read(fd, buffer, 0, MAX_LENGTH, 0, (_, bytesRead) => {
					resolve(buffer.subarray(0, bytesRead));
					fs.close(fd, () => {});
				});
			}
		});
	});
	module.exports = {
		LDD_PATH,
		SELF_PATH,
		readFileSync,
		readFile
	};
}));
//#endregion
//#region node_modules/detect-libc/lib/elf.js
var require_elf = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const interpreterPath = (elf) => {
		if (elf.length < 64) return null;
		if (elf.readUInt32BE(0) !== 2135247942) return null;
		if (elf.readUInt8(4) !== 2) return null;
		if (elf.readUInt8(5) !== 1) return null;
		const offset = elf.readUInt32LE(32);
		const size = elf.readUInt16LE(54);
		const count = elf.readUInt16LE(56);
		for (let i = 0; i < count; i++) {
			const headerOffset = offset + i * size;
			if (elf.readUInt32LE(headerOffset) === 3) {
				const fileOffset = elf.readUInt32LE(headerOffset + 8);
				const fileSize = elf.readUInt32LE(headerOffset + 32);
				return elf.subarray(fileOffset, fileOffset + fileSize).toString().replace(/\0.*$/g, "");
			}
		}
		return null;
	};
	module.exports = { interpreterPath };
}));
//#endregion
//#region src/lib/platform.ts
var import_detect_libc = (/* @__PURE__ */ __commonJSMin(((exports, module) => {
	const childProcess = __require("child_process");
	const { isLinux, getReport } = require_process();
	const { LDD_PATH, SELF_PATH, readFile, readFileSync } = require_filesystem();
	const { interpreterPath } = require_elf();
	let cachedFamilyInterpreter;
	let cachedFamilyFilesystem;
	let cachedVersionFilesystem;
	const command = "getconf GNU_LIBC_VERSION 2>&1 || true; ldd --version 2>&1 || true";
	let commandOut = "";
	const safeCommand = () => {
		if (!commandOut) return new Promise((resolve) => {
			childProcess.exec(command, (err, out) => {
				commandOut = err ? " " : out;
				resolve(commandOut);
			});
		});
		return commandOut;
	};
	const safeCommandSync = () => {
		if (!commandOut) try {
			commandOut = childProcess.execSync(command, { encoding: "utf8" });
		} catch (_err) {
			commandOut = " ";
		}
		return commandOut;
	};
	/**
	* A String constant containing the value `glibc`.
	* @type {string}
	* @public
	*/
	const GLIBC = "glibc";
	/**
	* A Regexp constant to get the GLIBC Version.
	* @type {string}
	*/
	const RE_GLIBC_VERSION = /LIBC[a-z0-9 \-).]*?(\d+\.\d+)/i;
	/**
	* A String constant containing the value `musl`.
	* @type {string}
	* @public
	*/
	const MUSL = "musl";
	const isFileMusl = (f) => f.includes("libc.musl-") || f.includes("ld-musl-");
	const familyFromReport = () => {
		const report = getReport();
		if (report.header && report.header.glibcVersionRuntime) return GLIBC;
		if (Array.isArray(report.sharedObjects)) {
			if (report.sharedObjects.some(isFileMusl)) return MUSL;
		}
		return null;
	};
	const familyFromCommand = (out) => {
		const [getconf, ldd1] = out.split(/[\r\n]+/);
		if (getconf && getconf.includes(GLIBC)) return GLIBC;
		if (ldd1 && ldd1.includes(MUSL)) return MUSL;
		return null;
	};
	const familyFromInterpreterPath = (path) => {
		if (path) {
			if (path.includes("/ld-musl-")) return MUSL;
			else if (path.includes("/ld-linux-")) return GLIBC;
		}
		return null;
	};
	const getFamilyFromLddContent = (content) => {
		content = content.toString();
		if (content.includes("musl")) return MUSL;
		if (content.includes("GNU C Library")) return GLIBC;
		return null;
	};
	const familyFromFilesystem = async () => {
		if (cachedFamilyFilesystem !== void 0) return cachedFamilyFilesystem;
		cachedFamilyFilesystem = null;
		try {
			const lddContent = await readFile(LDD_PATH);
			cachedFamilyFilesystem = getFamilyFromLddContent(lddContent);
		} catch (e) {}
		return cachedFamilyFilesystem;
	};
	const familyFromFilesystemSync = () => {
		if (cachedFamilyFilesystem !== void 0) return cachedFamilyFilesystem;
		cachedFamilyFilesystem = null;
		try {
			const lddContent = readFileSync(LDD_PATH);
			cachedFamilyFilesystem = getFamilyFromLddContent(lddContent);
		} catch (e) {}
		return cachedFamilyFilesystem;
	};
	const familyFromInterpreter = async () => {
		if (cachedFamilyInterpreter !== void 0) return cachedFamilyInterpreter;
		cachedFamilyInterpreter = null;
		try {
			const selfContent = await readFile(SELF_PATH);
			const path = interpreterPath(selfContent);
			cachedFamilyInterpreter = familyFromInterpreterPath(path);
		} catch (e) {}
		return cachedFamilyInterpreter;
	};
	const familyFromInterpreterSync = () => {
		if (cachedFamilyInterpreter !== void 0) return cachedFamilyInterpreter;
		cachedFamilyInterpreter = null;
		try {
			const selfContent = readFileSync(SELF_PATH);
			const path = interpreterPath(selfContent);
			cachedFamilyInterpreter = familyFromInterpreterPath(path);
		} catch (e) {}
		return cachedFamilyInterpreter;
	};
	/**
	* Resolves with the libc family when it can be determined, `null` otherwise.
	* @returns {Promise<?string>}
	*/
	const family = async () => {
		let family = null;
		if (isLinux()) {
			family = await familyFromInterpreter();
			if (!family) {
				family = await familyFromFilesystem();
				if (!family) family = familyFromReport();
				if (!family) {
					const out = await safeCommand();
					family = familyFromCommand(out);
				}
			}
		}
		return family;
	};
	/**
	* Returns the libc family when it can be determined, `null` otherwise.
	* @returns {?string}
	*/
	const familySync = () => {
		let family = null;
		if (isLinux()) {
			family = familyFromInterpreterSync();
			if (!family) {
				family = familyFromFilesystemSync();
				if (!family) family = familyFromReport();
				if (!family) {
					const out = safeCommandSync();
					family = familyFromCommand(out);
				}
			}
		}
		return family;
	};
	/**
	* Resolves `true` only when the platform is Linux and the libc family is not `glibc`.
	* @returns {Promise<boolean>}
	*/
	const isNonGlibcLinux = async () => isLinux() && await family() !== GLIBC;
	/**
	* Returns `true` only when the platform is Linux and the libc family is not `glibc`.
	* @returns {boolean}
	*/
	const isNonGlibcLinuxSync = () => isLinux() && familySync() !== GLIBC;
	const versionFromFilesystem = async () => {
		if (cachedVersionFilesystem !== void 0) return cachedVersionFilesystem;
		cachedVersionFilesystem = null;
		try {
			const versionMatch = (await readFile(LDD_PATH)).match(RE_GLIBC_VERSION);
			if (versionMatch) cachedVersionFilesystem = versionMatch[1];
		} catch (e) {}
		return cachedVersionFilesystem;
	};
	const versionFromFilesystemSync = () => {
		if (cachedVersionFilesystem !== void 0) return cachedVersionFilesystem;
		cachedVersionFilesystem = null;
		try {
			const versionMatch = readFileSync(LDD_PATH).match(RE_GLIBC_VERSION);
			if (versionMatch) cachedVersionFilesystem = versionMatch[1];
		} catch (e) {}
		return cachedVersionFilesystem;
	};
	const versionFromReport = () => {
		const report = getReport();
		if (report.header && report.header.glibcVersionRuntime) return report.header.glibcVersionRuntime;
		return null;
	};
	const versionSuffix = (s) => s.trim().split(/\s+/)[1];
	const versionFromCommand = (out) => {
		const [getconf, ldd1, ldd2] = out.split(/[\r\n]+/);
		if (getconf && getconf.includes(GLIBC)) return versionSuffix(getconf);
		if (ldd1 && ldd2 && ldd1.includes(MUSL)) return versionSuffix(ldd2);
		return null;
	};
	/**
	* Resolves with the libc version when it can be determined, `null` otherwise.
	* @returns {Promise<?string>}
	*/
	const version = async () => {
		let version = null;
		if (isLinux()) {
			version = await versionFromFilesystem();
			if (!version) version = versionFromReport();
			if (!version) {
				const out = await safeCommand();
				version = versionFromCommand(out);
			}
		}
		return version;
	};
	/**
	* Returns the libc version when it can be determined, `null` otherwise.
	* @returns {?string}
	*/
	const versionSync = () => {
		let version = null;
		if (isLinux()) {
			version = versionFromFilesystemSync();
			if (!version) version = versionFromReport();
			if (!version) {
				const out = safeCommandSync();
				version = versionFromCommand(out);
			}
		}
		return version;
	};
	module.exports = {
		GLIBC,
		MUSL,
		family,
		familySync,
		isNonGlibcLinux,
		isNonGlibcLinuxSync,
		version,
		versionSync
	};
})))();
const architectureNames = (cpu, byteOrder) => {
	if (cpu === "x64") return ["x86_64"];
	if (cpu === "arm64") return ["aarch64"];
	if (cpu === "riscv64") return ["riscv64gc", "riscv64"];
	if (cpu === "loong64") return ["loongarch64", "loong64"];
	if (cpu === "ppc64" && byteOrder === "LE") return ["powerpc64le"];
	return [cpu];
};
const platformNames = (os, libc) => {
	if (os === "win32") return ["pc-windows-msvc"];
	if (os === "darwin") return ["apple-darwin"];
	if (os === "android") return ["linux-android"];
	if (os === "linux" && libc !== void 0) return [`unknown-linux-${libc}`];
	return [];
};
const resolveRuntimePlatform = async (options = {}) => {
	const os = options.os ?? platform();
	const cpu = options.cpu ?? arch();
	const byteOrder = options.byteOrder ?? endianness();
	let libc = options.libc;
	if (os === "linux" && libc === void 0) {
		const detected = await (options.detectLibc ?? import_detect_libc.family)();
		if (detected === import_detect_libc.GLIBC) libc = "gnu";
		else if (detected === import_detect_libc.MUSL) libc = "musl";
		else throw new Error("Could not determine whether this Linux runner uses GNU libc or musl");
	}
	const architecture = architectureNames(cpu, byteOrder)[0] ?? cpu;
	const targetPlatform = platformNames(os, libc)[0] ?? os;
	return {
		os,
		cpu,
		libc,
		byteOrder,
		cacheKey: `${architecture}-${targetPlatform}`
	};
};
const selectReleaseAsset = (assets, target) => {
	const architectures = architectureNames(target.cpu, target.byteOrder);
	const platforms = platformNames(target.os, target.libc);
	const candidates = architectures.flatMap((architecture) => platforms.map((targetPlatform) => `dprint-${architecture}-${targetPlatform}.zip`));
	const asset = candidates.map((name) => assets.find((candidate) => candidate.name === name)).find(Boolean);
	if (asset !== void 0) return asset;
	const published = assets.filter((candidate) => candidate.name.endsWith(".zip")).map((candidate) => candidate.name).sort();
	throw new Error(`No dprint release asset matches ${target.os}-${target.cpu}. Tried: ${candidates.join(", ") || "none"}. Published ZIPs: ${published.join(", ") || "none"}`);
};
//#endregion
//#region src/lib/version.ts
const USER_AGENT = "dprint-check-action";
const REPOSITORY = "dprint/dprint";
const jsonClient = { async getJson(url, headers = {}) {
	const requestHeaders = new Headers();
	for (const [name, value] of Object.entries(headers)) if (value !== void 0) requestHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value));
	const response = await fetch(url, { headers: requestHeaders });
	return {
		statusCode: response.status,
		result: await response.json()
	};
} };
const specifiedVersion = (input) => {
	const requested = input.trim();
	return requested === "" || requested.toLowerCase() === "latest" ? void 0 : requested;
};
const isRelease = (value) => {
	if (value === null || typeof value !== "object") return false;
	const release = value;
	return typeof release.tag_name === "string" && release.tag_name !== "" && Array.isArray(release.assets) && release.assets.every((asset) => asset !== null && typeof asset === "object" && typeof asset.name === "string" && typeof asset.browser_download_url === "string" && (asset.digest === null || typeof asset.digest === "string"));
};
const resolveRelease = async (input, token = "", http = jsonClient) => {
	const requested = specifiedVersion(input);
	const endpoint = requested === void 0 ? `https://api.github.com/repos/${REPOSITORY}/releases/latest` : `https://api.github.com/repos/${REPOSITORY}/releases/tags/${encodeURIComponent(requested)}`;
	const headers = {
		accept: "application/vnd.github+json",
		"user-agent": USER_AGENT,
		"x-github-api-version": "2026-03-10"
	};
	if (token !== "") headers.authorization = `Bearer ${token}`;
	const response = await http.getJson(endpoint, headers);
	if (response.statusCode === 404) throw new Error(requested === void 0 ? "The latest dprint release was not found" : `dprint release ${requested} was not found`);
	if (response.statusCode !== 200 || !isRelease(response.result)) throw new Error(`Failed to resolve dprint release ${requested ?? "latest"} (HTTP ${response.statusCode})`);
	return response.result;
};
//#endregion
//#region src/lib/install.ts
const installDir = () => env["DPRINT_INSTALL"] ?? join(homedir(), ".dprint");
const installDprint = async (versionInput, cacheEnabled, token) => {
	let release;
	let version = specifiedVersion(versionInput);
	if (version === void 0) {
		release = await resolveRelease("latest", token);
		version = release.tag_name;
	}
	info(`Resolved dprint version: ${version}`);
	const target = await resolveRuntimePlatform();
	debug(`Runtime platform: os=${target.os}; cpu=${target.cpu}; libc=${target.libc ?? "none"}; byte-order=${target.byteOrder}; cache-key=${target.cacheKey}`);
	const extension = target.os === "win32" ? ".exe" : "";
	if (cacheEnabled) {
		const cachedDir = findTool("dprint", version, target.cacheKey);
		debug(`Tool-cache lookup for dprint ${version} (${target.cacheKey}): ${cachedDir || "miss"}`);
		if (cachedDir !== "") {
			info(`Cache hit: dprint ${version} from tool-cache`);
			return await finalize(join(cachedDir, `dprint${extension}`), true, target.cacheKey);
		}
	}
	const binDir = join(installDir(), "bin", target.cacheKey, version);
	const binaryPath = join(binDir, `dprint${extension}`);
	const binaryKey = `dprint-bin-v2-${target.cacheKey}-${version}`;
	const useActionsCache = cacheEnabled && isCacheAvailable();
	debug(`Binary install directory: ${binDir}`);
	debug(`Binary cache key: ${binaryKey}; Actions cache enabled: ${useActionsCache}`);
	if (cacheEnabled && !useActionsCache) warning("GitHub Actions cache is unavailable; downloading dprint directly");
	if (useActionsCache) try {
		const hitKey = await restoreCache([binDir], binaryKey);
		debug(`Binary cache restore result: ${hitKey ?? "miss"}; binary present: ${existsSync(binaryPath)}`);
		if (hitKey !== void 0 && existsSync(binaryPath)) {
			info(`Cache hit: dprint ${version} from actions/cache`);
			return await finalize(binaryPath, true, target.cacheKey);
		}
	} catch (error) {
		warning(`Failed to restore dprint binary cache: ${describeError(error)}`);
	}
	release ??= await resolveRelease(version, token);
	debug(`Published release assets: ${release.assets.map((candidate) => candidate.name).join(", ")}`);
	let asset;
	try {
		asset = selectReleaseAsset(release.assets, target);
	} catch (error) {
		throw new Error(`dprint ${version} cannot be installed on ${target.cacheKey}: ${describeError(error)}`);
	}
	info(`Selected release asset: ${asset.name}`);
	const expectedChecksum = await resolveReleaseAssetChecksum(version, asset, release.assets);
	info(`Downloading dprint ${version}`);
	const zipPath = await downloadTool(asset.browser_download_url);
	await verifyReleaseAsset(zipPath, asset, expectedChecksum);
	info(`Verified SHA-256 checksum for ${asset.name}`);
	const extractedDir = await extractZip(zipPath);
	const extractedBinary = join(extractedDir, `dprint${extension}`);
	debug(`Extracted ${asset.name} to ${extractedDir}`);
	if (target.os !== "win32") await execFileAsync("chmod", ["+x", extractedBinary]);
	await mkdir(binDir, { recursive: true });
	await cp(extractedBinary, binaryPath);
	if (cacheEnabled) {
		await cacheToolDirectory(extractedDir, "dprint", version, target.cacheKey);
		debug(`Stored dprint ${version} in tool-cache for ${target.cacheKey}`);
	}
	if (useActionsCache) {
		saveState("BIN_CACHE_KEY", binaryKey);
		saveState("BIN_CACHE_DIR", binDir);
	}
	return await finalize(binaryPath, false, target.cacheKey);
};
const finalize = async (binaryPath, cacheHit, platformKey) => {
	addPath(dirname(binaryPath));
	debug(`Verifying installed binary: ${binaryPath} --version`);
	const { stdout } = await execFileAsync(binaryPath, ["--version"]);
	const output = String(stdout);
	const version = output.trim().split(" ").pop() ?? output.trim();
	setOutput("version", version);
	setOutput("location", binaryPath);
	setOutput("cache-hit", cacheHit);
	info(`dprint ${version} ready at ${binaryPath}`);
	return {
		version,
		location: binaryPath,
		cacheHit,
		platformKey
	};
};
//#endregion
//#region src/lib/warmup.ts
const ATTEMPTS = 3;
const TIMEOUT_MS = 6e4;
const isTimeoutKill = (error) => {
	if (error === null || typeof error !== "object") return false;
	const killed = "killed" in error && error.killed === true;
	const signal = "signal" in error && (error.signal === "SIGTERM" || error.signal === "SIGKILL");
	return killed && signal;
};
const warmupConfig = async (binaryPath, configPath, execute) => {
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) try {
		await execute(binaryPath, [
			"output-file-paths",
			"--config",
			configPath
		], {
			timeout: TIMEOUT_MS,
			cwd: dirname(configPath),
			maxBuffer: 67108864
		});
		info(`Plugin warmup complete: ${configPath}`);
		return true;
	} catch (error) {
		if (!isTimeoutKill(error)) {
			warning(`Plugin warmup failed: ${describeError(error)}`);
			return false;
		}
		info(`Plugin warmup hung (>${TIMEOUT_MS / 1e3}s), attempt ${attempt}/${ATTEMPTS}`);
	}
	throw new Error(`Plugin warmup kept hanging after ${ATTEMPTS} attempts`);
};
const warmupPlugins = async (binaryPath, configPaths, execute = execFileAsync) => {
	for (const configPath of configPaths) if (!await warmupConfig(binaryPath, configPath, execute)) return false;
	return true;
};
//#endregion
//#region src/main.ts
const pluginCacheDir = () => env["DPRINT_CACHE_DIR"] ?? join(homedir(), ".cache", "dprint");
const restorePluginCache = async (cacheDir, version, platformKey, binaryPath, configPathInput) => {
	const configPaths = await findConfigFiles(configPathInput || void 0);
	debug(`Discovered ${configPaths.length} dprint config file(s)`);
	if (configPaths.length === 0) {
		info("No dprint config found; skipping plugin cache");
		return;
	}
	info(`Config files in plugin cache key: ${configPaths.join(", ")}`);
	const { primaryKey, restoreKeys } = computeCacheKey(configPaths, version, platformKey);
	debug(`Plugin cache primary key: ${primaryKey}`);
	debug(`Plugin cache restore keys: ${restoreKeys.join(", ")}`);
	saveState("PLUGIN_CACHE_KEY", primaryKey);
	saveState("PLUGIN_CACHE_DIR", cacheDir);
	setOutput("plugin-cache-key", primaryKey);
	let hitKey;
	try {
		hitKey = await restoreCache([cacheDir], primaryKey, restoreKeys);
	} catch (error) {
		warning(`Failed to restore dprint plugin cache: ${describeError(error)}`);
	}
	const exactHit = hitKey === primaryKey;
	debug(`Plugin cache restore result: ${hitKey ?? "miss"}; exact hit: ${exactHit}`);
	setOutput("plugin-cache-hit", exactHit);
	if (hitKey !== void 0) info(`Plugin cache restored from: ${hitKey}`);
	else info("Plugin cache miss");
	if (exactHit) {
		saveState("PLUGIN_CACHE_EXACT_HIT", "true");
		return;
	}
	if (await warmupPlugins(binaryPath, configPaths)) saveState("PLUGIN_CACHE_READY", "true");
};
const run = async () => {
	try {
		const versionInput = getInput("dprint-version") || "latest";
		const token = getInput("token");
		if (token !== "") setSecret(token);
		const configPathInput = getInput("config-path");
		const additionalArgs = getInput("args", { trimWhitespace: false });
		const cacheEnabled = getInput("cache") !== "false";
		const checkEnabled = getInput("run-check") !== "false";
		const cacheDir = pluginCacheDir();
		debug(`Inputs: dprint-version=${versionInput}; token=${token === "" ? "not provided" : "provided"}; cache=${cacheEnabled}; run-check=${checkEnabled}; config-path=${configPathInput || "auto"}; args=${additionalArgs === "" ? "none" : "provided"}`);
		debug(`Plugin cache directory: ${cacheDir}`);
		exportVariable("DPRINT_CACHE_DIR", cacheDir);
		setOutput("plugin-cache-hit", false);
		setOutput("plugin-cache-key", "");
		const { version, location, platformKey } = await installDprint(versionInput, cacheEnabled, token);
		if (cacheEnabled && isCacheAvailable()) await restorePluginCache(cacheDir, version, platformKey, location, configPathInput);
		else if (cacheEnabled) warning("GitHub Actions cache is unavailable; skipping plugin cache");
		if (checkEnabled) {
			debug("Running dprint check");
			await checkFormatting(location, configPathInput, additionalArgs);
		} else info("dprint installed; check skipped because run-check is false");
	} catch (error) {
		setFailed(describeError(error));
	}
};
run();
//#endregion
export {};
