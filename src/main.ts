import { rm } from "node:fs/promises";
import { join } from "node:path";
import { env } from "node:process";

import {
	debug,
	error as annotateError,
	exportVariable,
	getInput,
	info,
	isDebug,
	saveState,
	setFailed,
	setOutput,
	setSecret,
	warning,
} from "#lib/actions";
import { isCacheAvailable, restoreCache } from "#lib/cache";
import { checkConfigurations, isFormattingFailure, supportsReviewDiffs } from "#lib/check";
import {
	computeCacheKey,
	type ConfigGraph,
	findConfigFiles,
	prepareConfigRoots,
	type PreparedConfigRoots,
	resolveConfigGraph,
} from "#lib/config";
import { ACTION_INPUT, ACTION_OUTPUT, ACTION_STATE, ACTION_VALUE, DPRINT, ENVIRONMENT } from "#lib/contracts";
import { describeError } from "#lib/error";
import { installDprint } from "#lib/install";
import {
	parseRepository,
	PLUGIN_CACHE_ENVIRONMENT,
	type ReleaseRepository,
	resolvePluginCacheDirectory,
} from "#lib/repository";
import { postFormattingReview } from "#lib/review";
import type { ExistingSuggestion } from "#lib/review-threads";
import type { FormattingDiff } from "#lib/suggestions";
import { warmupPlugins } from "#lib/warmup";

const restorePluginCache = async (
	cacheDir: string,
	version: string,
	platformKey: string,
	binaryPath: string,
	config: ConfigGraph | undefined,
	configRoots: readonly string[],
	debugEnabled: boolean,
	repository: ReleaseRepository,
): Promise<void> => {
	debug(`Discovered ${configRoots.length} dprint config root(s)`);
	if (config === undefined) {
		info("No dprint config found; skipping plugin cache");
		return;
	}

	info(`Using ${config.roots.length} config root(s) and ${config.sources.length} resolved config source(s)`);
	const { primaryKey, restoreKeys } = computeCacheKey(config, version, platformKey, repository);
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
	if (await warmupPlugins(binaryPath, configRoots, { debug: debugEnabled })) {
		saveState(ACTION_STATE.pluginCacheReady, ACTION_VALUE.true);
	}
};

export const run = async (): Promise<void> => {
	let preparedConfig: PreparedConfigRoots | undefined;
	try {
		const versionInput = getInput(ACTION_INPUT.dprintVersion) || DPRINT.latestVersion;
		const repository = parseRepository(getInput(ACTION_INPUT.repository));
		const token = getInput(ACTION_INPUT.token);
		if (token !== "") setSecret(token);
		const configPathInput = getInput(ACTION_INPUT.configPath);
		const additionalArgs = getInput(ACTION_INPUT.args, { trimWhitespace: false });
		const cacheEnabled = getInput(ACTION_INPUT.cache) !== ACTION_VALUE.false;
		const binaryCacheEnabled = getInput(ACTION_INPUT.cacheBinary) === ACTION_VALUE.true;
		const installOnly = getInput(ACTION_INPUT.installOnly) === ACTION_VALUE.true;
		const annotationsEnabled = getInput(ACTION_INPUT.annotations) !== ACTION_VALUE.false;
		const reviewEnabled = getInput(ACTION_INPUT.review) === ACTION_VALUE.true;
		const debugEnabled = isDebug();
		const { root: cacheRoot, directory: cacheDir } = resolvePluginCacheDirectory(repository, env);
		exportVariable(PLUGIN_CACHE_ENVIRONMENT.root, cacheRoot);
		exportVariable(PLUGIN_CACHE_ENVIRONMENT.path, cacheDir);
		debug(
			`Inputs: ${ACTION_INPUT.repository}=${repository.name}; ${ACTION_INPUT.dprintVersion}=${versionInput}; ${ACTION_INPUT.token}=${
				token === "" ? "not provided" : "provided"
			}; ${ACTION_INPUT.cache}=${cacheEnabled}; ${ACTION_INPUT.cacheBinary}=${binaryCacheEnabled}; ${ACTION_INPUT.installOnly}=${installOnly}; ${ACTION_INPUT.configPath}=${
				configPathInput || "auto"
			}; ${ACTION_INPUT.annotations}=${annotationsEnabled}; ${ACTION_INPUT.args}=${
				additionalArgs === "" ? "none" : "provided"
			}`,
		);
		debug(`Plugin cache directory: ${cacheDir}`);
		exportVariable(ENVIRONMENT.dprintCacheDirectory, cacheDir);
		setOutput(ACTION_OUTPUT.pluginCacheHit, false);
		setOutput(ACTION_OUTPUT.pluginCacheKey, "");

		const { version, location, platformKey } = await installDprint(versionInput, binaryCacheEnabled, token, repository);
		const cacheAvailable = cacheEnabled && isCacheAvailable();
		let config: ConfigGraph | undefined;
		if (!installOnly || cacheAvailable) {
			const configRoots = await findConfigFiles(configPathInput || undefined);
			if (configPathInput !== "" && configRoots.length === 0) {
				throw new Error("config-path did not match any dprint configuration");
			}
			if (configRoots.length !== 0) {
				config = await resolveConfigGraph(configRoots);
				preparedConfig = await prepareConfigRoots(config);
				if (preparedConfig.materialized) {
					info("Materialized remote dprint configuration locally for process-plugin compatibility");
				}
			}
		}

		if (cacheAvailable) {
			await restorePluginCache(
				cacheDir,
				version,
				platformKey,
				location,
				config,
				preparedConfig?.roots ?? [],
				debugEnabled,
				repository,
			);
		} else if (cacheEnabled) info("GitHub Actions cache is unavailable; skipping plugin cache");

		if (!installOnly) {
			debug("Running dprint check");
			const reviewSupported = reviewEnabled && await supportsReviewDiffs(location);
			if (reviewEnabled && !reviewSupported) {
				warning(
					"Formatting review skipped: installed dprint does not advertise JSON unified diffs; using regular check annotations",
				);
			}
			const checkRoots = configPathInput === "" && preparedConfig?.materialized !== true
				? [""]
				: (preparedConfig?.roots ?? []);
			const diffs: FormattingDiff[] = [];
			const pendingAnnotations: Array<
				{ message: string; properties: NonNullable<Parameters<typeof annotateError>[1]> }
			> = [];
			let covered: readonly ExistingSuggestion[] = [];
			try {
				await checkConfigurations(location, checkRoots, additionalArgs, {
					annotations: annotationsEnabled,
					debug: debugEnabled,
					...(reviewSupported
						? {
							onDiffs: (found: readonly FormattingDiff[]) => diffs.push(...found),
							annotate: (message, properties) => pendingAnnotations.push({ message, properties }),
						}
						: {}),
				});
			} catch (error) {
				// Publish only a complete formatting result, never a partial run interrupted by a config/plugin error.
				if (reviewSupported && diffs.length !== 0 && isFormattingFailure(error)) {
					covered = await postFormattingReview(diffs, { token });
				}
				throw error;
			} finally {
				const emitted = new Set<string>();
				for (const { message, properties } of pendingAnnotations) {
					const key = JSON.stringify(properties);
					const exists = covered.some(suggestion =>
						suggestion.path === properties.file
						&& suggestion.startLine === properties.line
						&& suggestion.endLine === (properties.endLine ?? properties.line)
					);
					if (!exists && !emitted.has(key)) {
						annotateError(message, properties);
						emitted.add(key);
					}
				}
			}
		} else info("dprint installed; check skipped because install-only is true");
	} catch (error) {
		if (isFormattingFailure(error)) process.exitCode = 1;
		else setFailed(describeError(error));
	} finally {
		if (preparedConfig !== undefined) {
			try {
				await preparedConfig.cleanup();
			} catch (error) {
				warning(`Failed cleaning generated dprint configuration: ${describeError(error)}`);
			}
		}
	}
};

void run();
