export const ACTION_INPUT = {
	annotations: "annotations",
	args: "args",
	cache: "cache",
	configPath: "config-path",
	dprintVersion: "dprint-version",
	installOnly: "install-only",
	token: "token",
} as const;

export const ACTION_OUTPUT = {
	cacheHit: "cache-hit",
	location: "location",
	pluginCacheHit: "plugin-cache-hit",
	pluginCacheKey: "plugin-cache-key",
	version: "version",
} as const;

export const ACTION_STATE = {
	binaryCacheDirectory: "BIN_CACHE_DIR",
	binaryCacheKey: "BIN_CACHE_KEY",
	pluginCacheDirectory: "PLUGIN_CACHE_DIR",
	pluginCacheExactHit: "PLUGIN_CACHE_EXACT_HIT",
	pluginCacheKey: "PLUGIN_CACHE_KEY",
	pluginCacheReady: "PLUGIN_CACHE_READY",
} as const;

export const ACTION_VALUE = {
	false: "false",
	true: "true",
} as const;

export const ENVIRONMENT = {
	actionsCacheMode: "ACTIONS_CACHE_MODE",
	actionsResultsUrl: "ACTIONS_RESULTS_URL",
	actionsRuntimeToken: "ACTIONS_RUNTIME_TOKEN",
	dprintCacheDirectory: "DPRINT_CACHE_DIR",
	dprintInstallDirectory: "DPRINT_INSTALL",
	githubEnvironmentFile: "GITHUB_ENV",
	githubOutputFile: "GITHUB_OUTPUT",
	githubPathFile: "GITHUB_PATH",
	githubServerUrl: "GITHUB_SERVER_URL",
	githubStateFile: "GITHUB_STATE",
	githubWorkspace: "GITHUB_WORKSPACE",
	runnerDebug: "RUNNER_DEBUG",
	runnerTemporaryDirectory: "RUNNER_TEMP",
	runnerToolCache: "RUNNER_TOOL_CACHE",
} as const;

export const DPRINT = {
	binaryCacheVersion: 2,
	checkFailureExitCode: 20,
	checksumAsset: "SHASUMS256.txt",
	command: {
		check: "check",
		config: "--config",
		listDifferent: "--list-different",
		logLevel: "--log-level",
		version: "--version",
		warmup: "output-file-paths",
	},
	latestVersion: "latest",
	logLevel: { debug: "debug" },
	name: "dprint",
	pluginCacheVersion: 2,
	remoteCacheDirectory: "remote",
	sha256Algorithm: "sha256",
} as const;

export const RUNTIME_OS = {
	android: "android",
	linux: "linux",
	macos: "darwin",
	windows: "win32",
} as const;
