import { glob } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { cwd, env } from "node:process";
import { fileURLToPath, URL } from "node:url";

import { ENVIRONMENT } from "#lib/contracts";

const CONFIG_NAMES = ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc"] as const;

const workspacePath = () => env[ENVIRONMENT.githubWorkspace] ?? cwd();

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

const isRemoteConfig = (value: string): boolean => remoteUrl(value) !== undefined;

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
