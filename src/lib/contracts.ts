export const ACTION_INPUT = {
	args: "args",
	configPath: "config-path",
	dprintVersion: "dprint-version",
	token: "token",
} as const;

export const ACTION_OUTPUT = {
	location: "location",
	version: "version",
} as const;

export const ENVIRONMENT = {
	dprintInstallDirectory: "DPRINT_INSTALL",
	githubEnvironmentFile: "GITHUB_ENV",
	githubOutputFile: "GITHUB_OUTPUT",
	githubPathFile: "GITHUB_PATH",
	githubServerUrl: "GITHUB_SERVER_URL",
	githubWorkspace: "GITHUB_WORKSPACE",
	runnerDebug: "RUNNER_DEBUG",
	runnerTemporaryDirectory: "RUNNER_TEMP",
} as const;

export const DPRINT = {
	checkFailureExitCode: 20,
	checksumAsset: "SHASUMS256.txt",
	command: {
		check: "check",
		config: "--config",
		logLevel: "--log-level",
		version: "--version",
	},
	latestVersion: "latest",
	logLevel: { debug: "debug" },
	name: "dprint",
	sha256Algorithm: "sha256",
} as const;

export const RUNTIME_OS = {
	android: "android",
	linux: "linux",
	macos: "darwin",
	windows: "win32",
} as const;
