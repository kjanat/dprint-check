import { dirname } from "node:path";
import { cwd, env } from "node:process";

import { info, warning } from "#lib/actions";
import { isRemoteConfig } from "#lib/config";
import { DPRINT, ENVIRONMENT } from "#lib/contracts";
import { describeError } from "#lib/error";
import { execFileAsync } from "#lib/exec";

export const WARMUP_ATTEMPTS = 3;
export const WARMUP_MAX_BUFFER = 64 * 1024 * 1024;
export const WARMUP_TIMEOUT_MS = 60_000;
type Execute = (file: string, args: string[], options: {
	timeout: number;
	cwd: string;
	maxBuffer: number;
}) => Promise<unknown>;

const isTimeoutKill = (error: unknown): boolean => {
	if (error === null || typeof error !== "object") return false;
	const killed = "killed" in error && error.killed === true;
	const signal = "signal" in error && (error.signal === "SIGTERM" || error.signal === "SIGKILL");
	return killed && signal;
};

const warmupConfig = async (binaryPath: string, configPath: string, execute: Execute): Promise<boolean> => {
	for (let attempt = 1; attempt <= WARMUP_ATTEMPTS; attempt++) {
		try {
			await execute(binaryPath, [DPRINT.command.warmup, DPRINT.command.config, configPath], {
				timeout: WARMUP_TIMEOUT_MS,
				cwd: isRemoteConfig(configPath) ? (env[ENVIRONMENT.githubWorkspace] ?? cwd()) : dirname(configPath),
				maxBuffer: WARMUP_MAX_BUFFER,
			});
			info(`Plugin warmup complete: ${configPath}`);
			return true;
		} catch (error) {
			if (!isTimeoutKill(error)) {
				warning(`Plugin warmup failed: ${describeError(error)}`);
				return false;
			}
			info(`Plugin warmup hung (>${WARMUP_TIMEOUT_MS / 1000}s), attempt ${attempt}/${WARMUP_ATTEMPTS}`);
		}
	}
	throw new Error(`Plugin warmup kept hanging after ${WARMUP_ATTEMPTS} attempts`);
};

export const warmupPlugins = async (
	binaryPath: string,
	configPaths: readonly string[],
	execute: Execute = execFileAsync,
): Promise<boolean> => {
	for (const configPath of configPaths) {
		if (!await warmupConfig(binaryPath, configPath, execute)) return false;
	}
	return true;
};
