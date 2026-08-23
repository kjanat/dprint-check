import { dirname } from "node:path";

import { info, warning } from "#lib/actions";
import { execFileAsync } from "#lib/exec";

const ATTEMPTS = 3;
const TIMEOUT_MS = 60_000;
type Execute = (file: string, args: string[], options: {
	timeout: number;
	cwd: string;
	maxBuffer: number;
}) => Promise<unknown>;

function isTimeoutKill(error: unknown): boolean {
	if (error === null || typeof error !== "object") return false;
	const killed = "killed" in error && error.killed === true;
	const signal = "signal" in error && (error.signal === "SIGTERM" || error.signal === "SIGKILL");
	return killed && signal;
}

async function warmupConfig(binaryPath: string, configPath: string, execute: Execute): Promise<boolean> {
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		try {
			await execute(binaryPath, ["output-file-paths", "--config", configPath], {
				timeout: TIMEOUT_MS,
				cwd: dirname(configPath),
				maxBuffer: 64 * 1024 * 1024,
			});
			info(`Plugin warmup complete: ${configPath}`);
			return true;
		} catch (error) {
			if (!isTimeoutKill(error)) {
				warning(`Plugin warmup failed: ${describe(error)}`);
				return false;
			}
			info(`Plugin warmup hung (>${TIMEOUT_MS / 1000}s), attempt ${attempt}/${ATTEMPTS}`);
		}
	}
	throw new Error(`Plugin warmup kept hanging after ${ATTEMPTS} attempts`);
}

export async function warmupPlugins(
	binaryPath: string,
	configPaths: readonly string[],
	execute: Execute = execFileAsync,
): Promise<boolean> {
	for (const configPath of configPaths) {
		if (!await warmupConfig(binaryPath, configPath, execute)) return false;
	}
	return true;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
