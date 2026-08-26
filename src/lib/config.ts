import { createHash, randomUUID } from "node:crypto";
import { glob, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cwd, env } from "node:process";
import { fileURLToPath, URL } from "node:url";

import { DPRINT, ENVIRONMENT } from "#lib/contracts";
import { requestWithRetry, type RetryTransportOptions } from "#lib/http";

const CONFIG_NAMES = ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc"] as const;
const GENERATED_CONFIG_PREFIX = ".dprint-check-";
const GENERATED_CONFIG_EXCLUDE = `**/${GENERATED_CONFIG_PREFIX}*.json`;
const MAX_REDIRECTS = 10;

interface ConfigSource {
	content: string;
	remote: boolean;
	source: string;
}

export interface ConfigGraph {
	aliases: Map<string, string>;
	hasRemote: boolean;
	origins: Map<string, string>;
	roots: string[];
	rootSources: string[];
	sources: ConfigSource[];
}

export interface PreparedConfigRoots {
	cleanup: () => Promise<void>;
	materialized: boolean;
	roots: string[];
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

export const parseConfigPaths = (input: string): string[] =>
	input.split(/[\t\r\n|]+/u).map(value => value.trim()).filter(value => value !== "");

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
		const matches: string[] = [];
		for (const value of parseConfigPaths(customPath)) {
			const normalized = normalizeRoot(value);
			if (isRemoteConfig(normalized)) matches.push(normalized);
			else matches.push(...(await Array.fromAsync(glob(normalized))).sort());
		}
		return [...new Set(matches)];
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

const configObject = (content: string, source: string): Record<string, unknown> => {
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
	return config as Record<string, unknown>;
};

const configExtends = (content: string, source: string): string[] => {
	const value = configObject(content, source).extends;
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
	const aliases = new Map<string, string>();
	const origins = new Map<string, string>();
	const sources = new Map<string, ConfigSource>();
	const resolved = new Set<string>();
	const resolving = new Set<string>();

	const load = (source: string): Promise<ConfigSource> => {
		let pending = loaded.get(source);
		if (pending === undefined) {
			pending = loadConfig(source, options);
			loaded.set(source, pending);
		}
		return pending.then(config => {
			aliases.set(source, config.source);
			return config;
		});
	};

	const visit = async (config: ConfigSource, origin: string): Promise<void> => {
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
	const rootSources: string[] = [];
	for (const root of normalizedRoots) {
		const config = await load(root);
		rootSources.push(config.source);
		await visit(config, config.source);
	}

	return {
		aliases,
		hasRemote: [...sources.values()].some(source => source.remote),
		origins,
		roots: normalizedRoots,
		rootSources,
		sources: [...sources.values()],
	};
};

const withoutChecksum = (value: string): string => value.replace(/@[\da-f]{64}$/iu, "");

const isWasmPlugin = (value: string): boolean => {
	const source = withoutChecksum(value);
	const url = parseUrl(source);
	const path = url === undefined ? source : url.pathname;
	return path.toLowerCase().endsWith(".wasm");
};

const needsLocalCompatibility = (source: ConfigSource): boolean => {
	if (!source.remote) return false;
	const config = configObject(source.content, source.source);
	const plugins = config.plugins;
	return source.content.includes("${configDir}") || source.content.includes("${originConfigDir}")
		|| (Array.isArray(plugins) && plugins.some(plugin => typeof plugin === "string" && !isWasmPlugin(plugin)));
};

const absoluteRemotePlugin = (value: string, source: string): string => {
	const plugin = withoutChecksum(value);
	const checksum = value.slice(plugin.length);
	return parseUrl(plugin) === undefined ? `${new URL(plugin, source).href}${checksum}` : value;
};

export const prepareConfigRoots = async (config: ConfigGraph): Promise<PreparedConfigRoots> => {
	if (!config.sources.some(needsLocalCompatibility)) {
		return { cleanup: async () => {}, materialized: false, roots: config.roots };
	}

	const generated = new Map(
		config.sources.map(source => [
			source.source,
			join(source.remote ? workspacePath() : dirname(source.source), `${GENERATED_CONFIG_PREFIX}${randomUUID()}.json`),
		]),
	);
	const paths = [...generated.values()];
	const cleanup = async (): Promise<void> => {
		await Promise.all(paths.map(path => rm(path, { force: true })));
	};

	try {
		await Promise.all(config.sources.map(async source => {
			const value = configObject(source.content, source.source);
			const extendsValue = value.extends;
			if (typeof extendsValue === "string" || Array.isArray(extendsValue)) {
				const references = configExtends(source.content, source.source).map(reference => {
					const resolved = resolveConfigReference(
						reference,
						source.source,
						config.origins.get(source.source) ?? source.source,
					);
					const actual = config.aliases.get(resolved) ?? resolved;
					return generated.get(actual) ?? actual;
				});
				value.extends = typeof extendsValue === "string" ? references[0] : references;
			}
			if (source.remote && Array.isArray(value.plugins)) {
				value.plugins = value.plugins.map(plugin =>
					typeof plugin === "string" ? absoluteRemotePlugin(plugin, source.source) : plugin
				);
			}
			if (
				config.rootSources.includes(source.source) && (value.excludes === undefined || Array.isArray(value.excludes))
			) {
				value.excludes = [...(value.excludes ?? []), GENERATED_CONFIG_EXCLUDE];
			}
			const path = generated.get(source.source);
			if (path === undefined) throw new Error(`Missing generated path for dprint config ${source.source}`);
			await writeFile(path, `${JSON.stringify(value, undefined, "\t")}\n`, { encoding: "utf8", flag: "wx" });
		}));
	} catch (error) {
		await cleanup();
		throw error;
	}

	return {
		cleanup,
		materialized: true,
		roots: config.rootSources.map(root => generated.get(root) ?? root),
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
