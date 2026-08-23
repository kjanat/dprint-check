import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { cwd, env } from "node:process";

export const CONFIG_NAMES = ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc"] as const;

const workspacePath = () => env["GITHUB_WORKSPACE"] ?? cwd();

export async function findConfigFiles(customPath?: string): Promise<string[]> {
	const workspace = workspacePath();
	if (customPath !== undefined && customPath.trim() !== "") {
		const pattern = isAbsolute(customPath) ? customPath : join(workspace, customPath);
		return (await Array.fromAsync(glob(pattern))).sort();
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
}

export function computeCacheKey(
	configPaths: readonly string[],
	dprintVersion: string,
	platformKey: string,
): { primaryKey: string; restoreKeys: string[] } {
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
		restoreKeys: [`${prefix}-`, `${platformPrefix}-`],
	};
}
