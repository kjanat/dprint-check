import { createRequire } from "node:module";
import { cp, glob, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { EOL, arch, endianness, homedir, platform, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cwd, env } from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, createReadStream, createWriteStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { URL as URL$1, fileURLToPath } from "node:url";
//#region \0rolldown/runtime.js
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
//#endregion
//#region src/lib/contracts.ts
const ACTION_INPUT = {
	annotations: "annotations",
	args: "args",
	cache: "cache",
	configPath: "config-path",
	dprintVersion: "dprint-version",
	installOnly: "install-only",
	token: "token"
};
const ACTION_OUTPUT = {
	cacheHit: "cache-hit",
	location: "location",
	pluginCacheHit: "plugin-cache-hit",
	pluginCacheKey: "plugin-cache-key",
	version: "version"
};
const ACTION_STATE = {
	binaryCacheDirectory: "BIN_CACHE_DIR",
	binaryCacheKey: "BIN_CACHE_KEY",
	pluginCacheDirectory: "PLUGIN_CACHE_DIR",
	pluginCacheExactHit: "PLUGIN_CACHE_EXACT_HIT",
	pluginCacheKey: "PLUGIN_CACHE_KEY",
	pluginCacheReady: "PLUGIN_CACHE_READY"
};
const ACTION_VALUE = {
	false: "false",
	true: "true"
};
const ENVIRONMENT = {
	actionsCacheMode: "ACTIONS_CACHE_MODE",
	actionsResultsUrl: "ACTIONS_RESULTS_URL",
	actionsRuntimeToken: "ACTIONS_RUNTIME_TOKEN",
	dprintCacheDirectory: "DPRINT_CACHE_DIR",
	dprintInstallDirectory: "DPRINT_INSTALL",
	githubEnvironmentFile: "GITHUB_ENV",
	githubOutputFile: "GITHUB_OUTPUT",
	githubPathFile: "GITHUB_PATH",
	githubServerUrl: "GITHUB_SERVER_URL",
	githubStateFile: "GITHUB_STATE",
	githubWorkspace: "GITHUB_WORKSPACE",
	runnerDebug: "RUNNER_DEBUG",
	runnerTemporaryDirectory: "RUNNER_TEMP",
	runnerToolCache: "RUNNER_TOOL_CACHE"
};
const DPRINT = {
	binaryCacheVersion: 2,
	checkFailureExitCode: 20,
	checksumAsset: "SHASUMS256.txt",
	command: {
		check: "check",
		config: "--config",
		listDifferent: "--list-different",
		logLevel: "--log-level",
		version: "--version",
		warmup: "output-file-paths"
	},
	latestVersion: "latest",
	logLevel: { debug: "debug" },
	name: "dprint",
	pluginCacheVersion: 2,
	remoteCacheDirectory: "remote",
	sha256Algorithm: "sha256"
};
const RUNTIME_OS = {
	android: "android",
	linux: "linux",
	macos: "darwin",
	windows: "win32"
};
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
const isDebug = () => env[ENVIRONMENT.runnerDebug] === "1";
const info = (message) => void process.stdout.write(`${message}${EOL}`);
const warning = (message) => command("warning", message);
const error = (message, properties = {}) => {
	command("error", message, Object.fromEntries(Object.entries(properties).filter((entry) => entry[1] !== void 0).map(([key, value]) => [key, String(value)])));
};
const setFailed = (message) => {
	process.exitCode = 1;
	error(message);
};
const setOutput = (name, value) => {
	const serialized = String(value);
	if (!fileCommand(ENVIRONMENT.githubOutputFile, name, serialized)) command("set-output", serialized, { name });
};
const saveState = (name, value) => {
	if (!fileCommand(ENVIRONMENT.githubStateFile, name, value)) command("save-state", value, { name });
};
const exportVariable = (name, value) => {
	env[name] = value;
	if (!fileCommand(ENVIRONMENT.githubEnvironmentFile, name, value)) command("set-env", value, { name });
};
const addPath = (path) => {
	env["PATH"] = `${path}${delimiter}${env["PATH"] ?? ""}`;
	const file = env[ENVIRONMENT.githubPathFile];
	if (file !== void 0 && file !== "") appendFileSync(file, `${path}${EOL}`, { encoding: "utf8" });
	else command("add-path", path);
};
//#endregion
//#region src/lib/exec.ts
const execFileAsync = promisify(execFile);
const GITHUB_API = {
	dprintReleasesUrl: `https://api.github.com/repos/dprint/dprint/releases`,
	jsonMediaType: "application/vnd.github+json",
	userAgent: "dprint-check-action",
	version: "2026-03-10",
	webUrl: "https://github.com"
};
const githubApiHeaders = (token = "") => ({
	accept: GITHUB_API.jsonMediaType,
	"user-agent": GITHUB_API.userAgent,
	"x-github-api-version": GITHUB_API.version,
	...token === "" ? {} : { authorization: `Bearer ${token}` }
});
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
const JSON_MEDIA_TYPE = "application/json";
const VERSION_SALT = "1.0";
const HTTP_HEADER = {
	contentLength: "content-length",
	contentType: "content-type",
	storageVersion: "x-ms-version"
};
const CACHE_SERVICE_METHOD = {
	create: "CreateCacheEntry",
	finalize: "FinalizeCacheEntryUpload",
	restore: "GetCacheEntryDownloadURL"
};
const CACHE_COMPRESSION = {
	gzip: "gzip",
	zstd: "zstd-without-long"
};
const CACHE_MODE = {
	none: "none",
	read: "read",
	write: "write",
	writeOnly: "write-only"
};
const CACHE_MODES = Object.values(CACHE_MODE);
const environment = (options) => options.environment ?? env;
const cacheModeAllows = (mode, operation) => {
	const normalized = mode?.trim().toLowerCase();
	if (normalized === void 0 || !CACHE_MODES.includes(normalized)) return true;
	if (operation === CACHE_MODE.read) return normalized === CACHE_MODE.read || normalized === CACHE_MODE.write;
	return normalized === CACHE_MODE.write || normalized === CACHE_MODE.writeOnly;
};
const isCacheAvailable = (environment = env) => {
	const server = new URL(environment[ENVIRONMENT.githubServerUrl] ?? GITHUB_API.webUrl).hostname.toUpperCase();
	return (server === "GITHUB.COM" || server.endsWith(".GHE.COM") || server.endsWith(".LOCALHOST")) && environment[ENVIRONMENT.actionsResultsUrl] !== void 0 && environment[ENVIRONMENT.actionsRuntimeToken] !== void 0;
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
	if (process.platform === RUNTIME_OS.windows) return CACHE_COMPRESSION.gzip;
	try {
		await execute("zstd", ["--quiet", "--version"]);
		return CACHE_COMPRESSION.zstd;
	} catch {
		return CACHE_COMPRESSION.gzip;
	}
};
const cacheVersion = (paths, method) => createHash(DPRINT.sha256Algorithm).update([
	...paths,
	method,
	VERSION_SALT
].join("|")).digest("hex");
const workspace = (environment) => environment[ENVIRONMENT.githubWorkspace] ?? process.cwd();
const tempDirectory = (environment) => createTemporaryDirectory(environment[ENVIRONMENT.runnerTemporaryDirectory] ?? tmpdir(), "dprint-cache-");
const archiveName = (method) => method === CACHE_COMPRESSION.gzip ? "cache.tgz" : "cache.tzst";
const tarCompression = (method, extract) => {
	if (method === CACHE_COMPRESSION.gzip) return [extract ? "-xzf" : "-czf"];
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
	const baseUrl = runtime[ENVIRONMENT.actionsResultsUrl];
	const token = runtime[ENVIRONMENT.actionsRuntimeToken];
	if (baseUrl === void 0 || token === void 0) throw new Error("GitHub Actions cache service is unavailable");
	const url = new URL(`/twirp/${SERVICE}/${method}`, baseUrl);
	const response = await request(url, {
		method: "POST",
		headers: {
			accept: JSON_MEDIA_TYPE,
			authorization: `Bearer ${token}`,
			[HTTP_HEADER.contentType]: JSON_MEDIA_TYPE
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
	if (!cacheModeAllows(environment(options)[ENVIRONMENT.actionsCacheMode], CACHE_MODE.read)) return void 0;
	const execute = options.execute ?? execFileAsync;
	const method = await compression(execute);
	const response = await twirp(CACHE_SERVICE_METHOD.restore, {
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
const CHECK_MAX_BUFFER = 67108864;
const ANNOTATION_MESSAGE = "File is not formatted. Run dprint fmt to fix.";
const ANNOTATION_TITLE = "dprint check";
const formattingFailures = /* @__PURE__ */ new WeakSet();
const asOutput = (value) => typeof value === "object" && value !== null ? value : {};
const outputText = (value) => value === void 0 ? "" : String(value);
const writeOutput = ({ stderr, stdout }) => {
	if (stdout !== void 0 && stdout.length !== 0) process.stdout.write(stdout);
	if (stderr !== void 0 && stderr.length !== 0) process.stderr.write(stderr);
};
const originalLine = (line) => {
	const separator = line.indexOf("|");
	if (separator === -1 || line[separator + 1] !== "-") return void 0;
	const numbers = line.slice(0, separator).match(/\d+/gu);
	return numbers === null ? void 0 : Number(numbers.at(-1));
};
const annotationPath = (file) => {
	if (!isAbsolute(file)) return file;
	const path = relative(env[ENVIRONMENT.githubWorkspace] ?? cwd(), file);
	return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path) ? path : file;
};
const parseCheckAnnotations = (output, listDifferent) => {
	const lines = stripVTControlCharacters(output).split(/\r?\n/u);
	if (listDifferent) return lines.filter((line) => line !== "").map((file) => ({ file: annotationPath(file) }));
	const annotations = [];
	let current;
	const finish = () => {
		if (current !== void 0) {
			if (current.endLine === current.line) delete current.endLine;
			annotations.push(current);
		}
		current = void 0;
	};
	for (const line of lines) {
		const header = /^from (.+):$/u.exec(line);
		if (header !== null) {
			const file = header[1];
			if (file === void 0) continue;
			finish();
			current = { file: annotationPath(file) };
		} else if (line === "--") finish();
		else if (current !== void 0) {
			const lineNumber = originalLine(line);
			if (lineNumber !== void 0) {
				current.line = Math.min(current.line ?? lineNumber, lineNumber);
				current.endLine = Math.max(current.endLine ?? lineNumber, lineNumber);
			}
		}
	}
	finish();
	return annotations;
};
const exitCode = (error) => {
	if (typeof error !== "object" || error === null || !("code" in error)) return void 0;
	return typeof error.code === "number" || typeof error.code === "string" ? error.code : void 0;
};
const isCheckFailure = (error) => typeof error === "object" && error !== null && Number(exitCode(error)) === DPRINT.checkFailureExitCode;
const listDifferent = async (binaryPath, args, execute) => {
	const listArgs = args.includes(DPRINT.command.listDifferent) ? args : [...args, DPRINT.command.listDifferent];
	try {
		return asOutput(await execute(binaryPath, listArgs, { maxBuffer: CHECK_MAX_BUFFER }));
	} catch (error) {
		return isCheckFailure(error) ? asOutput(error) : {};
	}
};
const isFormattingFailure = (error) => typeof error === "object" && error !== null && formattingFailures.has(error);
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
const buildCheckArgs = (configPath, additionalArgs, debug = false) => {
	const args = [DPRINT.command.check];
	if (configPath !== "") args.push(DPRINT.command.config, configPath);
	if (additionalArgs.trim() !== "") args.push(...parseArgs(additionalArgs));
	if (debug && !args.some((arg) => arg === DPRINT.command.logLevel || arg.startsWith(`${DPRINT.command.logLevel}=`))) args.push(DPRINT.command.logLevel, DPRINT.logLevel.debug);
	return args;
};
const checkFormatting = async (binaryPath, configPath, additionalArgs, options = {}) => {
	const { annotations = true, annotate = error, debug = false, execute = execFileAsync } = options;
	const args = buildCheckArgs(configPath, additionalArgs, debug);
	try {
		writeOutput(asOutput(await execute(binaryPath, args, { maxBuffer: CHECK_MAX_BUFFER })));
	} catch (error) {
		const output = asOutput(error);
		writeOutput(output);
		if (isCheckFailure(error)) {
			formattingFailures.add(error);
			if (!annotations) throw error;
			const diffLocations = new Map(parseCheckAnnotations(outputText(output.stdout), false).filter((annotation) => annotation.line !== void 0).map(({ file, ...location }) => [file, location]));
			const listed = await listDifferent(binaryPath, args, execute);
			for (const properties of parseCheckAnnotations(outputText(listed.stdout), true)) annotate(ANNOTATION_MESSAGE, {
				...properties,
				...diffLocations.get(properties.file),
				title: ANNOTATION_TITLE
			});
		}
		throw error;
	}
};
const checkConfigurations = async (binaryPath, configPaths, additionalArgs, options = {}) => {
	let formattingFailure;
	for (const configPath of configPaths) try {
		await checkFormatting(binaryPath, configPath, additionalArgs, options);
	} catch (error) {
		if (!isFormattingFailure(error)) throw error;
		formattingFailure ??= error;
	}
	if (formattingFailure !== void 0) throw formattingFailure;
};
//#endregion
//#region src/lib/config.ts
const CONFIG_NAMES = [
	"dprint.json",
	"dprint.jsonc",
	".dprint.json",
	".dprint.jsonc"
];
const MAX_REDIRECTS = 10;
const workspacePath = () => env[ENVIRONMENT.githubWorkspace] ?? cwd();
const nextJsonToken = (content, start) => {
	for (let index = start; index < content.length; index++) {
		if (/\s/u.test(content[index] ?? "")) continue;
		if (content[index] === "/" && content[index + 1] === "/") {
			index = content.indexOf("\n", index + 2);
			if (index < 0) return void 0;
			continue;
		}
		if (content[index] === "/" && content[index + 1] === "*") {
			index = content.indexOf("*/", index + 2);
			if (index < 0) return void 0;
			index++;
			continue;
		}
		return content[index];
	}
};
const normalizeJsonc = (content, source) => {
	let result = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < content.length; index++) {
		const character = content[index];
		if (inString) {
			result += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === "\"") inString = false;
			continue;
		}
		if (character === "\"") inString = true;
		else if (character === "/" && content[index + 1] === "/") {
			index = content.indexOf("\n", index + 2);
			if (index < 0) break;
			result += "\n";
			continue;
		} else if (character === "/" && content[index + 1] === "*") {
			const end = content.indexOf("*/", index + 2);
			if (end < 0) throw new Error(`Failed parsing dprint config ${source}: unterminated block comment`);
			result += " ";
			index = end + 1;
			continue;
		} else if (character === ",") {
			const next = nextJsonToken(content, index + 1);
			if (next === "}" || next === "]") continue;
		}
		result += character;
	}
	return result;
};
const parseUrl = (value) => {
	try {
		return new URL$1(value);
	} catch {
		return;
	}
};
const remoteUrl = (value) => {
	const url = parseUrl(value);
	return url?.protocol === "http:" || url?.protocol === "https:" ? url : void 0;
};
const isRemoteConfig = (value) => remoteUrl(value) !== void 0;
const parseConfigPaths = (input) => input.split(/[\t\r\n|]+/u).map((value) => value.trim()).filter((value) => value !== "");
const normalizeRoot = (value) => {
	if (isAbsolute(value)) return value;
	const url = parseUrl(value);
	if (url?.protocol === "file:") return fileURLToPath(url);
	if (url !== void 0) {
		if (remoteUrl(value) !== void 0) return url.href;
		throw new Error(`Unsupported config URL protocol: ${url.protocol}`);
	}
	return resolve(workspacePath(), value);
};
const findConfigFiles = async (customPath) => {
	const workspace = workspacePath();
	if (customPath !== void 0 && customPath.trim() !== "") {
		const matches = [];
		for (const value of parseConfigPaths(customPath)) {
			const normalized = normalizeRoot(value);
			if (isRemoteConfig(normalized)) matches.push(normalized);
			else matches.push(...(await Array.fromAsync(glob(normalized))).sort());
		}
		return [...new Set(matches)];
	}
	const matches = (await Array.fromAsync(glob(CONFIG_NAMES.map((name) => join(workspace, "**", name)), { exclude: [join(workspace, "**", "node_modules", "**"), join(workspace, "**", ".git", "**")] }))).sort();
	for (const name of CONFIG_NAMES) {
		const rootCandidate = join(workspace, name);
		if (matches.includes(rootCandidate)) return [rootCandidate, ...matches.filter((match) => match !== rootCandidate)];
	}
	return matches;
};
const configObject = (content, source) => {
	let config;
	try {
		config = JSON.parse(normalizeJsonc(content.replace(/^\uFEFF/u, ""), source));
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Failed parsing dprint config")) throw error;
		throw new Error(`Failed parsing dprint config ${source}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (config === null || typeof config !== "object" || Array.isArray(config)) throw new Error(`Failed parsing dprint config ${source}: expected an object`);
	return config;
};
const configExtends = (content, source) => {
	const value = configObject(content, source).extends;
	if (value === void 0) return [];
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
	throw new Error(`Invalid extends in dprint config ${source}: expected a string or an array of strings`);
};
const configDirectory = (source, template) => {
	if (isRemoteConfig(source)) throw new Error(`Cannot use \${${template}} in remote dprint config ${source}`);
	return dirname(source);
};
const expandConfigReference = (value, current, origin) => {
	const escapedOpen = "\0dprint-escaped-template\0";
	let expanded = value.replaceAll("\\${", escapedOpen);
	expanded = expanded.replace(/\$\{([^}]*)\}/gu, (_match, template) => {
		if (template === "") return "${}";
		if (template === "configDir") return configDirectory(current, template);
		if (template === "originConfigDir") return configDirectory(origin, template);
		throw new Error(`Unknown template literal \${${template}} in dprint config ${current}`);
	});
	return expanded.replaceAll(escapedOpen, "${");
};
const resolveConfigReference = (value, current, origin) => {
	const expanded = expandConfigReference(value, current, origin);
	if (isRemoteConfig(current)) {
		const url = parseUrl(expanded);
		if (url !== void 0 && remoteUrl(expanded) === void 0) throw new Error(`Unsupported config URL protocol: ${url.protocol}`);
		return new URL$1(expanded, current).href;
	}
	if (isAbsolute(expanded)) return expanded;
	const url = parseUrl(expanded);
	if (url?.protocol === "file:") return fileURLToPath(url);
	if (url !== void 0) {
		if (remoteUrl(expanded) !== void 0) return url.href;
		throw new Error(`Unsupported config URL protocol: ${url.protocol}`);
	}
	return resolve(dirname(current), expanded);
};
const loadRemoteConfig = async (source, options) => {
	let current = new URL$1(source);
	for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
		const response = await requestWithRetry(current, { redirect: "manual" }, options);
		const location = response.headers.get("location");
		if (location !== null) {
			current = new URL$1(location, current);
			continue;
		}
		if (!response.ok) throw new Error(`Failed downloading dprint config ${current.href}: HTTP ${response.status}`);
		return {
			content: await response.text(),
			remote: true,
			source: current.href
		};
	}
	throw new Error(`Too many redirects while downloading dprint config ${source}`);
};
const loadConfig = async (source, options) => {
	const url = remoteUrl(source);
	if (url !== void 0) return loadRemoteConfig(url.href, options);
	const path = isAbsolute(source) ? source : resolve(workspacePath(), source);
	return {
		content: await readFile(path, "utf8"),
		remote: false,
		source: path
	};
};
const resolveConfigGraph = async (roots, options = {}) => {
	const loaded = /* @__PURE__ */ new Map();
	const aliases = /* @__PURE__ */ new Map();
	const origins = /* @__PURE__ */ new Map();
	const sources = /* @__PURE__ */ new Map();
	const resolved = /* @__PURE__ */ new Set();
	const resolving = /* @__PURE__ */ new Set();
	const load = (source) => {
		let pending = loaded.get(source);
		if (pending === void 0) {
			pending = loadConfig(source, options);
			loaded.set(source, pending);
		}
		return pending.then((config) => {
			aliases.set(source, config.source);
			return config;
		});
	};
	const visit = async (config, origin) => {
		const stateKey = `${origin}\0${config.source}`;
		if (resolved.has(stateKey)) return;
		if (resolving.has(stateKey)) throw new Error(`Circular dprint config extends detected at ${config.source}`);
		resolving.add(stateKey);
		sources.set(config.source, config);
		if (!origins.has(config.source)) origins.set(config.source, origin);
		for (const reference of configExtends(config.content, config.source)) {
			const childSource = resolveConfigReference(reference, config.source, origin);
			await visit(await load(childSource), origin);
		}
		resolving.delete(stateKey);
		resolved.add(stateKey);
	};
	const normalizedRoots = roots.map(normalizeRoot);
	const rootSources = [];
	for (const root of normalizedRoots) {
		const config = await load(root);
		rootSources.push(config.source);
		await visit(config, config.source);
	}
	return {
		aliases,
		hasRemote: [...sources.values()].some((source) => source.remote),
		origins,
		roots: normalizedRoots,
		rootSources,
		sources: [...sources.values()]
	};
};
const withoutChecksum = (value) => value.replace(/@[\da-f]{64}$/iu, "");
const isWasmPlugin = (value) => {
	const source = withoutChecksum(value);
	const url = parseUrl(source);
	return (url === void 0 ? source : url.pathname).toLowerCase().endsWith(".wasm");
};
const needsLocalCompatibility = (source) => {
	if (!source.remote) return false;
	const plugins = configObject(source.content, source.source).plugins;
	return source.content.includes("${configDir}") || source.content.includes("${originConfigDir}") || Array.isArray(plugins) && plugins.some((plugin) => typeof plugin === "string" && !isWasmPlugin(plugin));
};
const absoluteRemotePlugin = (value, source) => {
	const plugin = withoutChecksum(value);
	const checksum = value.slice(plugin.length);
	return parseUrl(plugin) === void 0 ? `${new URL$1(plugin, source).href}${checksum}` : value;
};
const prepareConfigRoots = async (config) => {
	if (!config.sources.some(needsLocalCompatibility)) return {
		cleanup: async () => {},
		materialized: false,
		roots: config.roots
	};
	const generated = new Map(config.sources.map((source) => [source.source, join(source.remote ? workspacePath() : dirname(source.source), `.dprint-check-${randomUUID()}.json`)]));
	const paths = [...generated.values()];
	const cleanup = async () => {
		await Promise.all(paths.map((path) => rm(path, { force: true })));
	};
	try {
		await Promise.all(config.sources.map(async (source) => {
			const value = configObject(source.content, source.source);
			const extendsValue = value.extends;
			if (typeof extendsValue === "string" || Array.isArray(extendsValue)) {
				const references = configExtends(source.content, source.source).map((reference) => {
					const resolved = resolveConfigReference(reference, source.source, config.origins.get(source.source) ?? source.source);
					const actual = config.aliases.get(resolved) ?? resolved;
					return generated.get(actual) ?? actual;
				});
				value.extends = typeof extendsValue === "string" ? references[0] : references;
			}
			if (source.remote && Array.isArray(value.plugins)) value.plugins = value.plugins.map((plugin) => typeof plugin === "string" ? absoluteRemotePlugin(plugin, source.source) : plugin);
			const path = generated.get(source.source);
			if (path === void 0) throw new Error(`Missing generated path for dprint config ${source.source}`);
			await writeFile(path, `${JSON.stringify(value, void 0, "	")}\n`, {
				encoding: "utf8",
				flag: "wx"
			});
		}));
	} catch (error) {
		await cleanup();
		throw error;
	}
	return {
		cleanup,
		materialized: true,
		roots: config.rootSources.map((root) => generated.get(root) ?? root)
	};
};
const stableSource = (source) => isRemoteConfig(source) ? source : relative(workspacePath(), source).split(sep).join("/");
const computeCacheKey = (config, dprintVersion, platformKey) => {
	const hash = createHash(DPRINT.sha256Algorithm);
	for (const root of [...config.roots].sort()) {
		hash.update("root\0");
		hash.update(stableSource(root));
		hash.update("\0");
	}
	for (const source of [...config.sources].sort((left, right) => left.source.localeCompare(right.source))) {
		hash.update("source\0");
		hash.update(stableSource(source.source));
		hash.update("\0");
		hash.update(source.content);
		hash.update("\0");
	}
	const digest = hash.digest("hex");
	const platformPrefix = `${DPRINT.name}-plugins-v${DPRINT.pluginCacheVersion}-${platformKey}`;
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
const POWERSHELL_ARGUMENTS = [
	"-NoLogo",
	"-NoProfile",
	"-NonInteractive",
	"-Command"
];
const temporaryRoot = () => env[ENVIRONMENT.runnerTemporaryDirectory] ?? tmpdir();
const temporaryDirectory = (prefix) => createTemporaryDirectory(temporaryRoot(), prefix);
const toolPath = (tool, version, architecture) => {
	const root = env[ENVIRONMENT.runnerToolCache];
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
		debug(`${ENVIRONMENT.runnerToolCache} is unavailable; skipping tool-cache storage`);
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
	if (process.platform === RUNTIME_OS.windows) {
		const command = `Expand-Archive -LiteralPath ${powershellLiteral(archive)} -DestinationPath ${powershellLiteral(destination)} -Force`;
		try {
			await execFileAsync("pwsh", [...POWERSHELL_ARGUMENTS, command]);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			await execFileAsync("powershell", [...POWERSHELL_ARGUMENTS, command]);
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
	const prefix = `${DPRINT.sha256Algorithm}:`;
	if (asset.digest?.startsWith(prefix) !== true) return void 0;
	const digest = asset.digest.slice(prefix.length);
	return /^[0-9a-f]{64}$/iu.test(digest) ? digest.toLowerCase() : void 0;
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
	const manifestAsset = assets.find((candidate) => candidate.name === DPRINT.checksumAsset);
	if (manifestAsset === void 0) throw new Error(`dprint ${releaseTag} cannot be securely installed: the release provides neither a SHA-256 digest for ${asset.name} nor ${DPRINT.checksumAsset}`);
	const manifestPath = await download(manifestAsset.browser_download_url);
	const checksum = checksumFromManifest(await readFile(manifestPath, "utf8"), asset.name);
	if (checksum === void 0) throw new Error(`dprint ${releaseTag} cannot be securely installed: ${DPRINT.checksumAsset} has no checksum for ${asset.name}`);
	return checksum;
};
const sha256 = async (path) => {
	const hash = createHash(DPRINT.sha256Algorithm);
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
	if (os === RUNTIME_OS.windows) return ["pc-windows-msvc"];
	if (os === RUNTIME_OS.macos) return ["apple-darwin"];
	if (os === RUNTIME_OS.android) return ["linux-android"];
	if (os === RUNTIME_OS.linux && libc !== void 0) return [`unknown-linux-${libc}`];
	return [];
};
const resolveRuntimePlatform = async (options = {}) => {
	const os = options.os ?? platform();
	const cpu = options.cpu ?? arch();
	const byteOrder = options.byteOrder ?? endianness();
	let libc = options.libc;
	if (os === RUNTIME_OS.linux && libc === void 0) {
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
	return requested === "" || requested.toLowerCase() === DPRINT.latestVersion ? void 0 : requested;
};
const isRelease = (value) => {
	if (value === null || typeof value !== "object") return false;
	const release = value;
	return typeof release.tag_name === "string" && release.tag_name !== "" && Array.isArray(release.assets) && release.assets.every((asset) => asset !== null && typeof asset === "object" && typeof asset.name === "string" && typeof asset.browser_download_url === "string" && (asset.digest === null || typeof asset.digest === "string"));
};
const resolveRelease = async (input, token = "", http = jsonClient) => {
	const requested = specifiedVersion(input);
	const endpoint = requested === void 0 ? `${GITHUB_API.dprintReleasesUrl}/${DPRINT.latestVersion}` : `${GITHUB_API.dprintReleasesUrl}/tags/${encodeURIComponent(requested)}`;
	const response = await http.getJson(endpoint, githubApiHeaders(token));
	if (response.statusCode === 404) throw new Error(requested === void 0 ? "The latest dprint release was not found" : `dprint release ${requested} was not found`);
	if (response.statusCode !== 200 || !isRelease(response.result)) throw new Error(`Failed to resolve dprint release ${requested ?? DPRINT.latestVersion} (HTTP ${response.statusCode})`);
	return response.result;
};
//#endregion
//#region src/lib/install.ts
const installDir = () => env[ENVIRONMENT.dprintInstallDirectory] ?? join(homedir(), `.${DPRINT.name}`);
const installDprint = async (versionInput, cacheEnabled, token) => {
	let release;
	let version = specifiedVersion(versionInput);
	if (version === void 0) {
		release = await resolveRelease(DPRINT.latestVersion, token);
		version = release.tag_name;
	}
	info(`Resolved dprint version: ${version}`);
	const target = await resolveRuntimePlatform();
	debug(`Runtime platform: os=${target.os}; cpu=${target.cpu}; libc=${target.libc ?? "none"}; byte-order=${target.byteOrder}; cache-key=${target.cacheKey}`);
	const extension = target.os === RUNTIME_OS.windows ? ".exe" : "";
	if (cacheEnabled) {
		const cachedDir = findTool(DPRINT.name, version, target.cacheKey);
		debug(`Tool-cache lookup for dprint ${version} (${target.cacheKey}): ${cachedDir || "miss"}`);
		if (cachedDir !== "") {
			info(`Cache hit: dprint ${version} from tool-cache`);
			return await finalize(join(cachedDir, `${DPRINT.name}${extension}`), true, target.cacheKey);
		}
	}
	const binDir = join(installDir(), "bin", target.cacheKey, version);
	const binaryPath = join(binDir, `${DPRINT.name}${extension}`);
	const binaryKey = `${DPRINT.name}-bin-v${DPRINT.binaryCacheVersion}-${target.cacheKey}-${version}`;
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
	const extractedBinary = join(extractedDir, `${DPRINT.name}${extension}`);
	debug(`Extracted ${asset.name} to ${extractedDir}`);
	if (target.os !== RUNTIME_OS.windows) await execFileAsync("chmod", ["+x", extractedBinary]);
	await mkdir(binDir, { recursive: true });
	await cp(extractedBinary, binaryPath);
	if (cacheEnabled) {
		await cacheToolDirectory(extractedDir, DPRINT.name, version, target.cacheKey);
		debug(`Stored dprint ${version} in tool-cache for ${target.cacheKey}`);
	}
	if (useActionsCache) {
		saveState(ACTION_STATE.binaryCacheKey, binaryKey);
		saveState(ACTION_STATE.binaryCacheDirectory, binDir);
	}
	return await finalize(binaryPath, false, target.cacheKey);
};
const finalize = async (binaryPath, cacheHit, platformKey) => {
	addPath(dirname(binaryPath));
	debug(`Verifying installed binary: ${binaryPath} ${DPRINT.command.version}`);
	const { stdout } = await execFileAsync(binaryPath, [DPRINT.command.version]);
	const output = String(stdout);
	const version = output.trim().split(" ").pop() ?? output.trim();
	setOutput(ACTION_OUTPUT.version, version);
	setOutput(ACTION_OUTPUT.location, binaryPath);
	setOutput(ACTION_OUTPUT.cacheHit, cacheHit);
	info(`dprint ${version} ready at ${binaryPath}`);
	return {
		version,
		location: binaryPath,
		cacheHit,
		platformKey
	};
};
const WARMUP_MAX_BUFFER = 67108864;
const WARMUP_TIMEOUT_MS = 6e4;
const isTimeoutKill = (error) => {
	if (error === null || typeof error !== "object") return false;
	const killed = "killed" in error && error.killed === true;
	const signal = "signal" in error && (error.signal === "SIGTERM" || error.signal === "SIGKILL");
	return killed && signal;
};
const warmupConfig = async (binaryPath, configPath, debug, execute) => {
	const args = [
		DPRINT.command.warmup,
		DPRINT.command.config,
		configPath
	];
	if (debug) args.push(DPRINT.command.logLevel, DPRINT.logLevel.debug);
	for (let attempt = 1; attempt <= 3; attempt++) try {
		await execute(binaryPath, args, {
			timeout: WARMUP_TIMEOUT_MS,
			cwd: isRemoteConfig(configPath) ? env[ENVIRONMENT.githubWorkspace] ?? cwd() : dirname(configPath),
			maxBuffer: WARMUP_MAX_BUFFER
		});
		info(`Plugin warmup complete: ${configPath}`);
		return true;
	} catch (error) {
		if (!isTimeoutKill(error)) {
			warning(`Plugin warmup failed: ${describeError(error)}`);
			return false;
		}
		info(`Plugin warmup hung (>${WARMUP_TIMEOUT_MS / 1e3}s), attempt ${attempt}/3`);
	}
	throw new Error(`Plugin warmup kept hanging after 3 attempts`);
};
const warmupPlugins = async (binaryPath, configPaths, options = {}) => {
	const { debug = false, execute = execFileAsync } = options;
	for (const configPath of configPaths) if (!await warmupConfig(binaryPath, configPath, debug, execute)) return false;
	return true;
};
//#endregion
//#region src/main.ts
const pluginCacheDir = () => env[ENVIRONMENT.dprintCacheDirectory] ?? join(homedir(), ".cache", DPRINT.name);
const restorePluginCache = async (cacheDir, version, platformKey, binaryPath, config, configRoots, debugEnabled) => {
	debug(`Discovered ${configRoots.length} dprint config root(s)`);
	if (config === void 0) {
		info("No dprint config found; skipping plugin cache");
		return;
	}
	info(`Using ${config.roots.length} config root(s) and ${config.sources.length} resolved config source(s)`);
	const { primaryKey, restoreKeys } = computeCacheKey(config, version, platformKey);
	debug(`Plugin cache primary key: ${primaryKey}`);
	debug(`Plugin cache restore keys: ${restoreKeys.join(", ")}`);
	saveState(ACTION_STATE.pluginCacheKey, primaryKey);
	saveState(ACTION_STATE.pluginCacheDirectory, cacheDir);
	setOutput(ACTION_OUTPUT.pluginCacheKey, primaryKey);
	let hitKey;
	try {
		hitKey = await restoreCache([cacheDir], primaryKey, restoreKeys);
	} catch (error) {
		warning(`Failed to restore dprint plugin cache: ${describeError(error)}`);
	}
	const exactHit = hitKey === primaryKey;
	debug(`Plugin cache restore result: ${hitKey ?? "miss"}; exact hit: ${exactHit}`);
	setOutput(ACTION_OUTPUT.pluginCacheHit, exactHit);
	if (hitKey !== void 0) info(`Plugin cache restored from: ${hitKey}`);
	else info("Plugin cache miss");
	if (exactHit) {
		saveState(ACTION_STATE.pluginCacheExactHit, ACTION_VALUE.true);
		return;
	}
	if (config.hasRemote) {
		await rm(join(cacheDir, DPRINT.remoteCacheDirectory), {
			recursive: true,
			force: true
		});
		debug("Cleared restored remote files before plugin warmup");
	}
	if (await warmupPlugins(binaryPath, config.roots, { debug: debugEnabled })) saveState(ACTION_STATE.pluginCacheReady, ACTION_VALUE.true);
};
const run = async () => {
	let preparedConfig;
	try {
		const versionInput = getInput(ACTION_INPUT.dprintVersion) || DPRINT.latestVersion;
		const token = getInput(ACTION_INPUT.token);
		if (token !== "") setSecret(token);
		const configPathInput = getInput(ACTION_INPUT.configPath);
		const additionalArgs = getInput(ACTION_INPUT.args, { trimWhitespace: false });
		const cacheEnabled = getInput(ACTION_INPUT.cache) !== ACTION_VALUE.false;
		const installOnly = getInput(ACTION_INPUT.installOnly) === ACTION_VALUE.true;
		const annotationsEnabled = getInput(ACTION_INPUT.annotations) !== ACTION_VALUE.false;
		const debugEnabled = isDebug();
		const cacheDir = pluginCacheDir();
		debug(`Inputs: ${ACTION_INPUT.dprintVersion}=${versionInput}; ${ACTION_INPUT.token}=${token === "" ? "not provided" : "provided"}; ${ACTION_INPUT.cache}=${cacheEnabled}; ${ACTION_INPUT.installOnly}=${installOnly}; ${ACTION_INPUT.configPath}=${configPathInput || "auto"}; ${ACTION_INPUT.annotations}=${annotationsEnabled}; ${ACTION_INPUT.args}=${additionalArgs === "" ? "none" : "provided"}`);
		debug(`Plugin cache directory: ${cacheDir}`);
		exportVariable(ENVIRONMENT.dprintCacheDirectory, cacheDir);
		setOutput(ACTION_OUTPUT.pluginCacheHit, false);
		setOutput(ACTION_OUTPUT.pluginCacheKey, "");
		const { version, location, platformKey } = await installDprint(versionInput, cacheEnabled, token);
		const cacheAvailable = cacheEnabled && isCacheAvailable();
		let config;
		if (!installOnly || cacheAvailable) {
			const configRoots = await findConfigFiles(configPathInput || void 0);
			if (configPathInput !== "" && configRoots.length === 0) throw new Error("config-path did not match any dprint configuration");
			if (configRoots.length !== 0) {
				config = await resolveConfigGraph(configRoots);
				preparedConfig = await prepareConfigRoots(config);
				if (preparedConfig.materialized) info("Materialized remote dprint configuration locally for process-plugin compatibility");
			}
		}
		if (cacheAvailable) await restorePluginCache(cacheDir, version, platformKey, location, config, preparedConfig?.roots ?? [], debugEnabled);
		else if (cacheEnabled) warning("GitHub Actions cache is unavailable; skipping plugin cache");
		if (!installOnly) {
			debug("Running dprint check");
			const checkRoots = configPathInput === "" && preparedConfig?.materialized !== true ? [""] : preparedConfig?.roots ?? [];
			await checkConfigurations(location, checkRoots, additionalArgs, {
				annotations: annotationsEnabled,
				debug: debugEnabled
			});
		} else info("dprint installed; check skipped because install-only is true");
	} catch (error) {
		if (isFormattingFailure(error)) process.exitCode = 1;
		else setFailed(describeError(error));
	} finally {
		if (preparedConfig !== void 0) try {
			await preparedConfig.cleanup();
		} catch (error) {
			warning(`Failed cleaning generated dprint configuration: ${describeError(error)}`);
		}
	}
};
run();
//#endregion
export {};
