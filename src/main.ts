import { rm } from "node:fs/promises";
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
import { computeCacheKey, findConfigFiles, resolveConfigGraph } from "#lib/config";
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
	const configRoots = await findConfigFiles(configPathInput || undefined);
	debug(`Discovered ${configRoots.length} dprint config root(s)`);
	if (configRoots.length === 0) {
		info("No dprint config found; skipping plugin cache");
		return;
	}

	const config = await resolveConfigGraph(configRoots);
	info(`Using ${config.roots.length} config root(s) and ${config.sources.length} resolved config source(s)`);
	const { primaryKey, restoreKeys } = computeCacheKey(config, version, platformKey);
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

	if (config.hasRemote) {
		await rm(join(cacheDir, DPRINT.remoteCacheDirectory), { recursive: true, force: true });
		debug("Cleared restored remote files before plugin warmup");
	}
	if (await warmupPlugins(binaryPath, config.roots)) saveState(ACTION_STATE.pluginCacheReady, ACTION_VALUE.true);
};

const run = async (): Promise<void> => {
	try {
		const versionInput = getInput(ACTION_INPUT.dprintVersion) || DPRINT.latestVersion;
		const token = getInput(ACTION_INPUT.token);
		if (token !== "") setSecret(token);
		const configPathInput = getInput(ACTION_INPUT.configPath);
		const additionalArgs = getInput(ACTION_INPUT.args, { trimWhitespace: false });
		const cacheEnabled = getInput(ACTION_INPUT.cache) !== ACTION_VALUE.false;
		const installOnly = getInput(ACTION_INPUT.installOnly) === ACTION_VALUE.true;
		const annotationsEnabled = getInput(ACTION_INPUT.annotations) !== ACTION_VALUE.false;
		const cacheDir = pluginCacheDir();
		debug(
			`Inputs: ${ACTION_INPUT.dprintVersion}=${versionInput}; ${ACTION_INPUT.token}=${
				token === "" ? "not provided" : "provided"
			}; ${ACTION_INPUT.cache}=${cacheEnabled}; ${ACTION_INPUT.installOnly}=${installOnly}; ${ACTION_INPUT.configPath}=${
				configPathInput || "auto"
			}; ${ACTION_INPUT.annotations}=${annotationsEnabled}; ${ACTION_INPUT.args}=${
				additionalArgs === "" ? "none" : "provided"
			}`,
		);
		debug(`Plugin cache directory: ${cacheDir}`);
		exportVariable(ENVIRONMENT.dprintCacheDirectory, cacheDir);
		setOutput(ACTION_OUTPUT.pluginCacheHit, false);
		setOutput(ACTION_OUTPUT.pluginCacheKey, "");

		const { version, location, platformKey } = await installDprint(versionInput, cacheEnabled, token);
		if (cacheEnabled && isCacheAvailable()) {
			await restorePluginCache(cacheDir, version, platformKey, location, configPathInput);
		} else if (cacheEnabled) warning("GitHub Actions cache is unavailable; skipping plugin cache");

		if (!installOnly) {
			debug("Running dprint check");
			await checkFormatting(location, configPathInput, additionalArgs, { annotations: annotationsEnabled });
		} else info("dprint installed; check skipped because install-only is true");
	} catch (error) {
		setFailed(describeError(error));
	}
};

void run();
