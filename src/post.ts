import { isFeatureAvailable, saveCache } from "@actions/cache";
import { getState, info, warning } from "@actions/core";

async function save(paths: string[], key: string, label: string): Promise<void> {
	info(`Saving ${label}: ${paths.join(", ")} -> ${key}`);
	try {
		await saveCache(paths, key);
		info(`${label} saved`);
	} catch (error) {
		if (error instanceof Error && error.message.includes("already exists")) {
			info(`${label} entry already exists`);
		} else throw error;
	}
}

async function post(): Promise<void> {
	if (!isFeatureAvailable()) {
		info("GitHub Actions cache is unavailable; nothing to save");
		return;
	}

	try {
		const binaryKey = getState("BIN_CACHE_KEY");
		const binaryDir = getState("BIN_CACHE_DIR");
		if (binaryKey !== "" && binaryDir !== "") await save([binaryDir], binaryKey, "dprint binary cache");

		const pluginKey = getState("PLUGIN_CACHE_KEY");
		const pluginDir = getState("PLUGIN_CACHE_DIR");
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
		warning(`Cache save failed: ${describe(error)}`);
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

void post();
