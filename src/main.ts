import {
	debug,
	exportVariable,
	getInput,
	info,
	saveState,
	setFailed,
	setOutput,
	setSecret,
	warning,
} from "@actions/core";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";

import { isCacheAvailable, restoreCache } from "#lib/cache";
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
	platformKey: string,
	binaryPath: string,
	configPathInput: string,
): Promise<void> {
	const configPaths = await findConfigFiles(configPathInput || undefined);
	debug(`Discovered ${configPaths.length} dprint config file(s)`);
	if (configPaths.length === 0) {
		info("No dprint config found; skipping plugin cache");
		return;
	}

	info(`Config files in plugin cache key: ${configPaths.join(", ")}`);
	const { primaryKey, restoreKeys } = computeCacheKey(configPaths, version, platformKey);
	debug(`Plugin cache primary key: ${primaryKey}`);
	debug(`Plugin cache restore keys: ${restoreKeys.join(", ")}`);
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
	debug(`Plugin cache restore result: ${hitKey ?? "miss"}; exact hit: ${exactHit}`);
	setOutput("plugin-cache-hit", exactHit);
	if (hitKey !== undefined) info(`Plugin cache restored from: ${hitKey}`);
	else info("Plugin cache miss");
	if (exactHit) {
		saveState("PLUGIN_CACHE_EXACT_HIT", "true");
		return;
	}

	if (await warmupPlugins(binaryPath, configPaths)) saveState("PLUGIN_CACHE_READY", "true");
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
		debug(
			`Inputs: dprint-version=${versionInput}; token=${
				token === "" ? "not provided" : "provided"
			}; cache=${cacheEnabled}; run-check=${checkEnabled}; config-path=${configPathInput || "auto"}; args=${
				additionalArgs === "" ? "none" : "provided"
			}`,
		);
		debug(`Plugin cache directory: ${cacheDir}`);
		exportVariable("DPRINT_CACHE_DIR", cacheDir);
		setOutput("plugin-cache-hit", false);
		setOutput("plugin-cache-key", "");

		const { version, location, platformKey } = await installDprint(versionInput, cacheEnabled, token);
		if (cacheEnabled && isCacheAvailable()) {
			await restorePluginCache(cacheDir, version, platformKey, location, configPathInput);
		} else if (cacheEnabled) warning("GitHub Actions cache is unavailable; skipping plugin cache");

		if (checkEnabled) {
			debug("Running dprint check");
			await checkFormatting(location, configPathInput, additionalArgs);
		} else info("dprint installed; check skipped because run-check is false");
	} catch (error) {
		setFailed(describe(error));
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

void run();
