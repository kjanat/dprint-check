import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "node:process";

import { addPath, debug, info, saveState, setOutput, warning } from "#lib/actions";
import { isCacheAvailable, restoreCache } from "#lib/cache";
import { resolveReleaseAssetChecksum, verifyReleaseAsset } from "#lib/checksum";
import { ACTION_OUTPUT, ACTION_STATE, DPRINT, ENVIRONMENT, RUNTIME_OS } from "#lib/contracts";
import { describeError } from "#lib/error";
import { execFileAsync } from "#lib/exec";
import { resolveRuntimePlatform, selectReleaseAsset } from "#lib/platform";
import { cacheToolDirectory, downloadTool, extractZip, findTool } from "#lib/tool";
import type { Release, ReleaseAsset } from "#lib/version";
import { resolveRelease, specifiedVersion } from "#lib/version";

const installDir = (): string => env[ENVIRONMENT.dprintInstallDirectory] ?? join(homedir(), `.${DPRINT.name}`);

export const installDprint = async (versionInput: string, cacheEnabled: boolean, token: string): Promise<{
	version: string;
	location: string;
	cacheHit: boolean;
	platformKey: string;
}> => {
	let release: Release | undefined;
	let version = specifiedVersion(versionInput);
	if (version === undefined) {
		release = await resolveRelease(DPRINT.latestVersion, token);
		version = release.tag_name;
	}
	info(`Resolved dprint version: ${version}`);
	const target = await resolveRuntimePlatform();
	debug(
		`Runtime platform: os=${target.os}; cpu=${target.cpu}; libc=${
			target.libc ?? "none"
		}; byte-order=${target.byteOrder}; cache-key=${target.cacheKey}`,
	);
	const extension = target.os === RUNTIME_OS.windows ? ".exe" : "";

	if (cacheEnabled) {
		const cachedDir = findTool(DPRINT.name, version, target.cacheKey);
		debug(`Tool-cache lookup for dprint ${version} (${target.cacheKey}): ${cachedDir || "miss"}`);
		if (cachedDir !== "") {
			info(`Cache hit: dprint ${version} from tool-cache`);
			return await finalize(join(cachedDir, `${DPRINT.name}${extension}`), true, target.cacheKey);
		}
	}

	const binDir = join(installDir(), "bin", target.cacheKey, version);
	const binaryPath = join(binDir, `${DPRINT.name}${extension}`);
	const binaryKey = `${DPRINT.name}-bin-v${DPRINT.binaryCacheVersion}-${target.cacheKey}-${version}`;
	const useActionsCache = cacheEnabled && isCacheAvailable();
	debug(`Binary install directory: ${binDir}`);
	debug(`Binary cache key: ${binaryKey}; Actions cache enabled: ${useActionsCache}`);

	if (cacheEnabled && !useActionsCache) info("GitHub Actions cache is unavailable; downloading dprint directly");
	if (useActionsCache) {
		try {
			const hitKey = await restoreCache([binDir], binaryKey);
			debug(`Binary cache restore result: ${hitKey ?? "miss"}; binary present: ${existsSync(binaryPath)}`);
			if (hitKey !== undefined && existsSync(binaryPath)) {
				info(`Cache hit: dprint ${version} from actions/cache`);
				return await finalize(binaryPath, true, target.cacheKey);
			}
		} catch (error) {
			warning(`Failed to restore dprint binary cache: ${describeError(error)}`);
		}
	}

	release ??= await resolveRelease(version, token);
	debug(`Published release assets: ${release.assets.map(candidate => candidate.name).join(", ")}`);
	let asset: ReleaseAsset;
	try {
		asset = selectReleaseAsset(release.assets, target);
	} catch (error) {
		throw new Error(`dprint ${version} cannot be installed on ${target.cacheKey}: ${describeError(error)}`);
	}
	info(`Selected release asset: ${asset.name}`);
	const expectedChecksum = await resolveReleaseAssetChecksum(version, asset, release.assets);
	info(`Downloading dprint ${version}`);
	const zipPath = await downloadTool(asset.browser_download_url);
	await verifyReleaseAsset(zipPath, asset, expectedChecksum);
	info(`Verified SHA-256 checksum for ${asset.name}`);
	const extractedDir = await extractZip(zipPath);
	const extractedBinary = join(extractedDir, `${DPRINT.name}${extension}`);
	debug(`Extracted ${asset.name} to ${extractedDir}`);
	if (target.os !== RUNTIME_OS.windows) await execFileAsync("chmod", ["+x", extractedBinary]);

	await mkdir(binDir, { recursive: true });
	await cp(extractedBinary, binaryPath);
	if (cacheEnabled) {
		await cacheToolDirectory(extractedDir, DPRINT.name, version, target.cacheKey);
		debug(`Stored dprint ${version} in tool-cache for ${target.cacheKey}`);
	}

	if (useActionsCache) {
		saveState(ACTION_STATE.binaryCacheKey, binaryKey);
		saveState(ACTION_STATE.binaryCacheDirectory, binDir);
	}
	return await finalize(binaryPath, false, target.cacheKey);
};

const finalize = async (
	binaryPath: string,
	cacheHit: boolean,
	platformKey: string,
): Promise<{ version: string; location: string; cacheHit: boolean; platformKey: string }> => {
	addPath(dirname(binaryPath));
	debug(`Verifying installed binary: ${binaryPath} ${DPRINT.command.version}`);
	const { stdout } = await execFileAsync(binaryPath, [DPRINT.command.version]);
	const output = String(stdout);
	const version = output.trim().split(" ").pop() ?? output.trim();
	setOutput(ACTION_OUTPUT.version, version);
	setOutput(ACTION_OUTPUT.location, binaryPath);
	setOutput(ACTION_OUTPUT.cacheHit, cacheHit);
	info(`dprint ${version} ready at ${binaryPath}`);
	return { version, location: binaryPath, cacheHit, platformKey };
};
