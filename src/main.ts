import { isFeatureAvailable, restoreCache } from "@actions/cache";
import { exportVariable, getInput, info, saveState, setFailed, setOutput, setSecret, warning } from "@actions/core";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";

import { checkFormatting } from "#lib/check";
import { computeCacheKey, findConfigFiles } from "#lib/config";
import { installDprint } from "#lib/install";
import { warmupPlugins } from "#lib/warmup";

function pluginCacheDir(): string {
	return env["DPRINT_CACHE_DIR"] ?? join(homedir(), ".cache", "dprint");
}

async function restorePluginCache(
	cacheDir: string,
	version: string,
	binaryPath: string,
	configPathInput: string,
): Promise<void> {
	const configPaths = await findConfigFiles(configPathInput || undefined);
	const primaryConfig = configPaths[0];
	if (primaryConfig === undefined) {
		info("No dprint config found; skipping plugin cache");
		return;
	}

	info(`Config files in plugin cache key: ${configPaths.join(", ")}`);
	const { primaryKey, restoreKeys } = computeCacheKey(configPaths, version);
	saveState("PLUGIN_CACHE_KEY", primaryKey);
	saveState("PLUGIN_CACHE_DIR", cacheDir);
	setOutput("plugin-cache-key", primaryKey);

	let hitKey: string | undefined;
	try {
		hitKey = await restoreCache([cacheDir], primaryKey, restoreKeys);
	} catch (error) {
		warning(`Failed to restore dprint plugin cache: ${describe(error)}`);
	}

	const exactHit = hitKey === primaryKey;
	setOutput("plugin-cache-hit", exactHit);
	if (hitKey !== undefined) info(`Plugin cache restored from: ${hitKey}`);
	else info("Plugin cache miss");
	if (exactHit) {
		saveState("PLUGIN_CACHE_EXACT_HIT", "true");
		return;
	}

	if (await warmupPlugins(binaryPath, primaryConfig)) saveState("PLUGIN_CACHE_READY", "true");
}

async function run(): Promise<void> {
	try {
		const versionInput = getInput("dprint-version") || "latest";
		const token = getInput("token");
		if (token !== "") setSecret(token);
		const configPathInput = getInput("config-path");
		const additionalArgs = getInput("args", { trimWhitespace: false });
		const cacheEnabled = getInput("cache") !== "false";
		const checkEnabled = getInput("run-check") !== "false";
		const cacheDir = pluginCacheDir();
		exportVariable("DPRINT_CACHE_DIR", cacheDir);
		setOutput("plugin-cache-hit", false);
		setOutput("plugin-cache-key", "");

		const { version, location } = await installDprint(versionInput, cacheEnabled, token);
		if (cacheEnabled && isFeatureAvailable()) {
			await restorePluginCache(cacheDir, version, location, configPathInput);
		} else if (cacheEnabled) warning("GitHub Actions cache is unavailable; skipping plugin cache");

		if (checkEnabled) await checkFormatting(location, configPathInput, additionalArgs);
		else info("dprint installed; check skipped because run-check is false");
	} catch (error) {
		setFailed(describe(error));
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

void run();
