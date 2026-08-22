import { isFeatureAvailable, restoreCache } from "@actions/cache";
import { addPath, info, saveState, setOutput, warning } from "@actions/core";
import { exec } from "@actions/exec";
import { cp, mkdirP } from "@actions/io";
import { cacheDir, downloadTool, extractZip, find as findTool } from "@actions/tool-cache";
import { existsSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { env } from "node:process";
import { verifyReleaseAsset } from "./checksum.ts";
import { selectReleaseAsset } from "./platform.ts";
import { type Release, resolveRelease, specifiedVersion } from "./version.ts";

function installDir(): string {
	return env["DPRINT_INSTALL"] ?? join(homedir(), ".dprint");
}

export async function installDprint(versionInput: string, cacheEnabled: boolean): Promise<{
	version: string;
	location: string;
	cacheHit: boolean;
}> {
	let release: Release | undefined;
	let version = specifiedVersion(versionInput);
	if (version === undefined) {
		release = await resolveRelease("latest");
		version = release.tag_name;
	}
	info(`Resolved dprint version: ${version}`);
	const extension = platform() === "win32" ? ".exe" : "";

	if (cacheEnabled) {
		const cachedDir = findTool("dprint", version);
		if (cachedDir !== "") {
			info(`Cache hit: dprint ${version} from tool-cache`);
			return await finalize(join(cachedDir, `dprint${extension}`), true);
		}
	}

	const binDir = join(installDir(), "bin", version);
	const binaryPath = join(binDir, `dprint${extension}`);
	const runner = env["RUNNER_OS"] ?? platform();
	const binaryKey = `dprint-bin-v1-${runner}-${arch()}-${version}`;
	const useActionsCache = cacheEnabled && isFeatureAvailable();

	if (cacheEnabled && !useActionsCache) warning("GitHub Actions cache is unavailable; downloading dprint directly");
	if (useActionsCache) {
		try {
			const hitKey = await restoreCache([binDir], binaryKey);
			if (hitKey !== undefined && existsSync(binaryPath)) {
				info(`Cache hit: dprint ${version} from actions/cache`);
				return await finalize(binaryPath, true);
			}
		} catch (error) {
			warning(`Failed to restore dprint binary cache: ${describe(error)}`);
		}
	}

	release ??= await resolveRelease(version);
	const asset = await selectReleaseAsset(release.assets);
	info(`Selected release asset: ${asset.name}`);
	info(`Downloading dprint ${version}`);
	const zipPath = await downloadTool(asset.browser_download_url);
	await verifyReleaseAsset(zipPath, asset, release.assets);
	info(`Verified SHA-256 checksum for ${asset.name}`);
	const extractedDir = await extractZip(zipPath);
	const extractedBinary = join(extractedDir, `dprint${extension}`);
	if (platform() !== "win32") await exec("chmod", ["+x", extractedBinary]);

	await mkdirP(binDir);
	await cp(extractedBinary, binaryPath);
	if (cacheEnabled) await cacheDir(extractedDir, "dprint", version);

	if (useActionsCache) {
		saveState("BIN_CACHE_KEY", binaryKey);
		saveState("BIN_CACHE_DIR", binDir);
	}
	return await finalize(binaryPath, false);
}

async function finalize(
	binaryPath: string,
	cacheHit: boolean,
): Promise<{ version: string; location: string; cacheHit: boolean }> {
	addPath(dirname(binaryPath));
	let output = "";
	await exec(binaryPath, ["--version"], {
		listeners: { stdout: (data: Buffer) => output += data.toString() },
	});
	const version = output.trim().split(" ").pop() ?? output.trim();
	setOutput("version", version);
	setOutput("location", binaryPath);
	setOutput("cache-hit", cacheHit);
	info(`dprint ${version} ready at ${binaryPath}`);
	return { version, location: binaryPath, cacheHit };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
