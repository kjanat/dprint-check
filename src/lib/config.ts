import { createHash } from "node:crypto";
import { glob, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cwd, env } from "node:process";
import { fileURLToPath, URL } from "node:url";

import { DPRINT, ENVIRONMENT } from "#lib/contracts";
import { requestWithRetry, type RetryTransportOptions } from "#lib/http";

const CONFIG_NAMES = ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc"] as const;
const MAX_REDIRECTS = 10;

interface ConfigSource {
	content: string;
	remote: boolean;
	source: string;
}

export interface ConfigGraph {
	hasRemote: boolean;
	roots: string[];
	sources: ConfigSource[];
}

const workspacePath = () => env[ENVIRONMENT.githubWorkspace] ?? cwd();

const nextJsonToken = (content: string, start: number): string | undefined => {
	for (let index = start; index < content.length; index++) {
		if (/\s/u.test(content[index] ?? "")) continue;
		if (content[index] === "/" && content[index + 1] === "/") {
			index = content.indexOf("\n", index + 2);
			if (index < 0) return undefined;
			continue;
		}
		if (content[index] === "/" && content[index + 1] === "*") {
			index = content.indexOf("*/", index + 2);
			if (index < 0) return undefined;
			index++;
			continue;
		}
		return content[index];
	}
	return undefined;
};

const normalizeJsonc = (content: string, source: string): string => {
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

const parseUrl = (value: string): URL | undefined => {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
};

const remoteUrl = (value: string): URL | undefined => {
	const url = parseUrl(value);
	return url?.protocol === "http:" || url?.protocol === "https:" ? url : undefined;
};

export const isRemoteConfig = (value: string): boolean => remoteUrl(value) !== undefined;

const normalizeRoot = (value: string): string => {
	if (isAbsolute(value)) return value;
	const url = parseUrl(value);
	if (url?.protocol === "file:") return fileURLToPath(url);
	if (url !== undefined) {
		if (remoteUrl(value) !== undefined) return url.href;
		throw new Error(`Unsupported config URL protocol: ${url.protocol}`);
	}
	return resolve(workspacePath(), value);
};

export const findConfigFiles = async (customPath?: string): Promise<string[]> => {
	const workspace = workspacePath();
	if (customPath !== undefined && customPath.trim() !== "") {
		const normalized = normalizeRoot(customPath.trim());
		if (isRemoteConfig(normalized)) return [normalized];
		return (await Array.fromAsync(glob(normalized))).sort();
	}

	const matches = (await Array.fromAsync(glob(CONFIG_NAMES.map(name => join(workspace, "**", name)), {
		exclude: [join(workspace, "**", "node_modules", "**"), join(workspace, "**", ".git", "**")],
	}))).sort();

	for (const name of CONFIG_NAMES) {
		const rootCandidate = join(workspace, name);
		if (matches.includes(rootCandidate)) {
			return [rootCandidate, ...matches.filter(match => match !== rootCandidate)];
		}
	}

	return matches;
};

const configExtends = (content: string, source: string): string[] => {
	let config: unknown;
	try {
		config = JSON.parse(normalizeJsonc(content.replace(/^\uFEFF/u, ""), source));
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Failed parsing dprint config")) throw error;
		throw new Error(
			`Failed parsing dprint config ${source}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (config === null || typeof config !== "object" || Array.isArray(config)) {
		throw new Error(`Failed parsing dprint config ${source}: expected an object`);
	}

	const value = (config as { extends?: unknown }).extends;
	if (value === undefined) return [];
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every(item => typeof item === "string")) return value;
	throw new Error(`Invalid extends in dprint config ${source}: expected a string or an array of strings`);
};

const configDirectory = (source: string, template: string): string => {
	if (isRemoteConfig(source)) throw new Error(`Cannot use \${${template}} in remote dprint config ${source}`);
	return dirname(source);
};

const expandConfigReference = (value: string, current: string, origin: string): string => {
	const escapedOpen = "\0dprint-escaped-template\0";
	let expanded = value.replaceAll("\\${", escapedOpen);
	expanded = expanded.replace(/\$\{([^}]*)\}/gu, (_match, template: string) => {
		if (template === "") return "${}";
		if (template === "configDir") return configDirectory(current, template);
		if (template === "originConfigDir") return configDirectory(origin, template);
		throw new Error(`Unknown template literal \${${template}} in dprint config ${current}`);
	});
	return expanded.replaceAll(escapedOpen, "${");
};

const resolveConfigReference = (value: string, current: string, origin: string): string => {
	const expanded = expandConfigReference(value, current, origin);
	if (isRemoteConfig(current)) {
		const url = parseUrl(expanded);
		if (url !== undefined && remoteUrl(expanded) === undefined) {
			throw new Error(`Unsupported config URL protocol: ${url.protocol}`);
		}
		return new URL(expanded, current).href;
	}
	if (isAbsolute(expanded)) return expanded;
	const url = parseUrl(expanded);
	if (url?.protocol === "file:") return fileURLToPath(url);
	if (url !== undefined) {
		if (remoteUrl(expanded) !== undefined) return url.href;
		throw new Error(`Unsupported config URL protocol: ${url.protocol}`);
	}
	return resolve(dirname(current), expanded);
};

const loadRemoteConfig = async (source: string, options: RetryTransportOptions): Promise<ConfigSource> => {
	let current = new URL(source);
	for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
		const response = await requestWithRetry(current, { redirect: "manual" }, options);
		const location = response.headers.get("location");
		if (location !== null) {
			current = new URL(location, current);
			continue;
		}
		if (!response.ok) throw new Error(`Failed downloading dprint config ${current.href}: HTTP ${response.status}`);
		return { content: await response.text(), remote: true, source: current.href };
	}
	throw new Error(`Too many redirects while downloading dprint config ${source}`);
};

const loadConfig = async (source: string, options: RetryTransportOptions): Promise<ConfigSource> => {
	const url = remoteUrl(source);
	if (url !== undefined) return loadRemoteConfig(url.href, options);
	const path = isAbsolute(source) ? source : resolve(workspacePath(), source);
	return { content: await readFile(path, "utf8"), remote: false, source: path };
};

export const resolveConfigGraph = async (
	roots: readonly string[],
	options: RetryTransportOptions = {},
): Promise<ConfigGraph> => {
	const loaded = new Map<string, Promise<ConfigSource>>();
	const sources = new Map<string, ConfigSource>();
	const resolved = new Set<string>();
	const resolving = new Set<string>();

	const load = (source: string): Promise<ConfigSource> => {
		let pending = loaded.get(source);
		if (pending === undefined) {
			pending = loadConfig(source, options);
			loaded.set(source, pending);
		}
		return pending;
	};

	const visit = async (config: ConfigSource, origin: string): Promise<void> => {
		const stateKey = `${origin}\0${config.source}`;
		if (resolved.has(stateKey)) return;
		if (resolving.has(stateKey)) throw new Error(`Circular dprint config extends detected at ${config.source}`);
		resolving.add(stateKey);
		sources.set(config.source, config);
		for (const reference of configExtends(config.content, config.source)) {
			const childSource = resolveConfigReference(reference, config.source, origin);
			await visit(await load(childSource), origin);
		}
		resolving.delete(stateKey);
		resolved.add(stateKey);
	};

	const normalizedRoots = roots.map(normalizeRoot);
	for (const root of normalizedRoots) {
		const config = await load(root);
		await visit(config, config.source);
	}

	return {
		hasRemote: [...sources.values()].some(source => source.remote),
		roots: normalizedRoots,
		sources: [...sources.values()],
	};
};

const stableSource = (source: string): string =>
	isRemoteConfig(source) ? source : relative(workspacePath(), source).split(sep).join("/");

export const computeCacheKey = (
	config: ConfigGraph,
	dprintVersion: string,
	platformKey: string,
): { primaryKey: string; restoreKeys: string[] } => {
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
		restoreKeys: [`${prefix}-`, `${platformPrefix}-`],
	};
};
