import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";

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
} from "#lib/actions";
import { isCacheAvailable, restoreCache } from "#lib/cache";
import { checkFormatting } from "#lib/check";
import { computeCacheKey, findConfigFiles } from "#lib/config";
import { ACTION_INPUT, ACTION_OUTPUT, ACTION_STATE, ACTION_VALUE, DPRINT, ENVIRONMENT } from "#lib/contracts";
import { describeError } from "#lib/error";
import { installDprint } from "#lib/install";
import { warmupPlugins } from "#lib/warmup";

const pluginCacheDir = (): string => env[ENVIRONMENT.dprintCacheDirectory] ?? join(homedir(), ".cache", DPRINT.name);

const restorePluginCache = async (
	cacheDir: string,
	version: string,
	platformKey: string,
	binaryPath: string,
	configPathInput: string,
): Promise<void> => {
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
	saveState(ACTION_STATE.pluginCacheKey, primaryKey);
	saveState(ACTION_STATE.pluginCacheDirectory, cacheDir);
	setOutput(ACTION_OUTPUT.pluginCacheKey, primaryKey);

	let hitKey: string | undefined;
	try {
		hitKey = await restoreCache([cacheDir], primaryKey, restoreKeys);
	} catch (error) {
		warning(`Failed to restore dprint plugin cache: ${describeError(error)}`);
	}

	const exactHit = hitKey === primaryKey;
	debug(`Plugin cache restore result: ${hitKey ?? "miss"}; exact hit: ${exactHit}`);
	setOutput(ACTION_OUTPUT.pluginCacheHit, exactHit);
	if (hitKey !== undefined) info(`Plugin cache restored from: ${hitKey}`);
	else info("Plugin cache miss");
	if (exactHit) {
		saveState(ACTION_STATE.pluginCacheExactHit, ACTION_VALUE.true);
		return;
	}

	if (await warmupPlugins(binaryPath, configPaths)) saveState(ACTION_STATE.pluginCacheReady, ACTION_VALUE.true);
};

const run = async (): Promise<void> => {
	try {
		const versionInput = getInput(ACTION_INPUT.dprintVersion) || DPRINT.latestVersion;
		const token = getInput(ACTION_INPUT.token);
		if (token !== "") setSecret(token);
		const configPathInput = getInput(ACTION_INPUT.configPath);
		const additionalArgs = getInput(ACTION_INPUT.args, { trimWhitespace: false });
		const cacheEnabled = getInput(ACTION_INPUT.cache) !== ACTION_VALUE.false;
		const checkEnabled = getInput(ACTION_INPUT.runCheck) !== ACTION_VALUE.false;
		const cacheDir = pluginCacheDir();
		debug(
			`Inputs: ${ACTION_INPUT.dprintVersion}=${versionInput}; ${ACTION_INPUT.token}=${
				token === "" ? "not provided" : "provided"
			}; ${ACTION_INPUT.cache}=${cacheEnabled}; ${ACTION_INPUT.runCheck}=${checkEnabled}; ${ACTION_INPUT.configPath}=$
			{
				configPathInput || "auto"
			}; ${ACTION_INPUT.args}=${additionalArgs === "" ? "none" : "provided"}`,
		);
		debug(`Plugin cache directory: ${cacheDir}`);
		exportVariable(ENVIRONMENT.dprintCacheDirectory, cacheDir);
		setOutput(ACTION_OUTPUT.pluginCacheHit, false);
		setOutput(ACTION_OUTPUT.pluginCacheKey, "");

		const { version, location, platformKey } = await installDprint(versionInput, cacheEnabled, token);
		if (cacheEnabled && isCacheAvailable()) {
			await restorePluginCache(cacheDir, version, platformKey, location, configPathInput);
		} else if (cacheEnabled) warning("GitHub Actions cache is unavailable; skipping plugin cache");

		if (checkEnabled) {
			debug("Running dprint check");
			await checkFormatting(location, configPathInput, additionalArgs);
		} else info("dprint installed; check skipped because run-check is false");
	} catch (error) {
		setFailed(describeError(error));
	}
};

void run();
