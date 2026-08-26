import { debug, getInput, isDebug, setFailed } from "#lib/actions";
import { checkConfigurations, isFormattingFailure } from "#lib/check";
import { findConfigFiles } from "#lib/config";
import { ACTION_INPUT, DPRINT } from "#lib/contracts";
import { describeError } from "#lib/error";
import { installDprint } from "#lib/install";

const run = async (): Promise<void> => {
	try {
		const versionInput = getInput(ACTION_INPUT.dprintVersion) || DPRINT.latestVersion;
		const token = getInput(ACTION_INPUT.token);
		const configPathInput = getInput(ACTION_INPUT.configPath);
		const additionalArgs = getInput(ACTION_INPUT.args, { trimWhitespace: false });
		const debugEnabled = isDebug();
		debug(
			`Inputs: ${ACTION_INPUT.dprintVersion}=${versionInput}; ${ACTION_INPUT.token}=${
				token === "" ? "not provided" : "provided"
			}; ${ACTION_INPUT.configPath}=${configPathInput || "auto"}; ${ACTION_INPUT.args}=${
				additionalArgs === "" ? "none" : "provided"
			}`,
		);

		const { location } = await installDprint(versionInput, token);
		const configRoots = await findConfigFiles(configPathInput || undefined);
		if (configPathInput !== "" && configRoots.length === 0) {
			throw new Error("config-path did not match any dprint configuration");
		}

		debug("Running dprint check");
		const checkRoots = configPathInput === "" ? [""] : configRoots;
		await checkConfigurations(location, checkRoots, additionalArgs, { debug: debugEnabled });
	} catch (error) {
		if (isFormattingFailure(error)) process.exitCode = 1;
		else setFailed(describeError(error));
	}
};

void run();
