import { info, warning } from "@actions/core";
import { dirname } from "node:path";

import { execFileAsync } from "#lib/exec";

const ATTEMPTS = 3;
const TIMEOUT_MS = 60_000;

function isTimeoutKill(error: unknown): boolean {
	if (error === null || typeof error !== "object") return false;
	const killed = "killed" in error && error.killed === true;
	const signal = "signal" in error && (error.signal === "SIGTERM" || error.signal === "SIGKILL");
	return killed && signal;
}

export async function warmupPlugins(binaryPath: string, configPath: string): Promise<boolean> {
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		try {
			await execFileAsync(binaryPath, ["output-file-paths", "--config", configPath], {
				timeout: TIMEOUT_MS,
				cwd: dirname(configPath),
				maxBuffer: 64 * 1024 * 1024,
			});
			info("Plugin warmup complete");
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

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
