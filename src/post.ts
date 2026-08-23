import { debug, getState, info, warning } from "#lib/actions";
import { isCacheAvailable, saveCache } from "#lib/cache";
import { describeError } from "#lib/error";

const save = async (paths: string[], key: string, label: string): Promise<void> => {
	info(`Saving ${label}: ${paths.join(", ")} -> ${key}`);
	try {
		await saveCache(paths, key);
		info(`${label} saved`);
	} catch (error) {
		if (error instanceof Error && error.message.includes("already exists")) {
			info(`${label} entry already exists`);
		} else throw error;
	}
};

const post = async (): Promise<void> => {
	if (!isCacheAvailable()) {
		info("GitHub Actions cache is unavailable; nothing to save");
		return;
	}

	try {
		const binaryKey = getState("BIN_CACHE_KEY");
		const binaryDir = getState("BIN_CACHE_DIR");
		debug(`Post binary cache state: key=${binaryKey || "none"}; directory=${binaryDir || "none"}`);
		if (binaryKey !== "" && binaryDir !== "") await save([binaryDir], binaryKey, "dprint binary cache");

		const pluginKey = getState("PLUGIN_CACHE_KEY");
		const pluginDir = getState("PLUGIN_CACHE_DIR");
		debug(`Post plugin cache state: key=${pluginKey || "none"}; directory=${pluginDir || "none"}`);
		if (pluginKey === "" || pluginDir === "") {
			info("No plugin cache to save");
			return;
		}
		if (getState("PLUGIN_CACHE_EXACT_HIT") === "true") {
			info("Plugin cache already up to date");
			return;
		}
		if (getState("PLUGIN_CACHE_READY") !== "true") {
			info("Plugin cache warmup did not complete; skipping cache save");
			return;
		}
		await save([pluginDir], pluginKey, "dprint plugin cache");
	} catch (error) {
		warning(`Cache save failed: ${describeError(error)}`);
	}
};

void post();
