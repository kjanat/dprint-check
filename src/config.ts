import { create as globCreate } from "@actions/glob";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { arch } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { cwd, env, platform } from "node:process";

const CONFIG_NAMES = [".dprint.jsonc", ".dprint.json", "dprint.jsonc", "dprint.json"] as const;

function workspacePath(): string {
	return env["GITHUB_WORKSPACE"] ?? cwd();
}

export async function findConfigFiles(customPath?: string): Promise<string[]> {
	const workspace = workspacePath();
	if (customPath !== undefined && customPath.trim() !== "") {
		const pattern = isAbsolute(customPath) ? customPath : join(workspace, customPath);
		const globber = await globCreate(pattern, { followSymbolicLinks: false });
		return (await globber.glob()).sort();
	}

	const patterns = [
		...CONFIG_NAMES.map(name => join(workspace, "**", name)),
		`!${join(workspace, "**", "node_modules", "**")}`,
		`!${join(workspace, "**", ".git", "**")}`,
	];
	const globber = await globCreate(patterns.join("\n"), { followSymbolicLinks: false });
	const matches = (await globber.glob()).sort();

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
	const runner = env["RUNNER_OS"] ?? platform;
	const prefix = `dprint-plugins-v1-${runner}-${arch()}-${dprintVersion}`;

	return {
		primaryKey: `${prefix}-${digest}`,
		restoreKeys: [`${prefix}-`, `dprint-plugins-v1-${runner}-${arch()}-`],
	};
}
