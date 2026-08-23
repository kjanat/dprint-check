import { addPath, debug, info, saveState, setOutput, warning } from "@actions/core";
import { exec } from "@actions/exec";
import { cp, mkdirP } from "@actions/io";
import { cacheDir, downloadTool, extractZip, find as findTool } from "@actions/tool-cache";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "node:process";

import { isCacheAvailable, restoreCache } from "#lib/cache";
import { resolveReleaseAssetChecksum, verifyReleaseAsset } from "#lib/checksum";
import { resolveRuntimePlatform, selectReleaseAsset } from "#lib/platform";
import type { Release, ReleaseAsset } from "#lib/version";
import { resolveRelease, specifiedVersion } from "#lib/version";

function installDir(): string {
	return env["DPRINT_INSTALL"] ?? join(homedir(), ".dprint");
}

export async function installDprint(versionInput: string, cacheEnabled: boolean, token: string): Promise<{
	version: string;
	location: string;
	cacheHit: boolean;
	platformKey: string;
}> {
	let release: Release | undefined;
	let version = specifiedVersion(versionInput);
	if (version === undefined) {
		release = await resolveRelease("latest", token);
		version = release.tag_name;
	}
	info(`Resolved dprint version: ${version}`);
	const target = await resolveRuntimePlatform();
	debug(
		`Runtime platform: os=${target.os}; cpu=${target.cpu}; libc=${
			target.libc ?? "none"
		}; byte-order=${target.byteOrder}; cache-key=${target.cacheKey}`,
	);
	const extension = target.os === "win32" ? ".exe" : "";

	if (cacheEnabled) {
		const cachedDir = findTool("dprint", version, target.cacheKey);
		debug(`Tool-cache lookup for dprint ${version} (${target.cacheKey}): ${cachedDir || "miss"}`);
		if (cachedDir !== "") {
			info(`Cache hit: dprint ${version} from tool-cache`);
			return await finalize(join(cachedDir, `dprint${extension}`), true, target.cacheKey);
		}
	}

	const binDir = join(installDir(), "bin", target.cacheKey, version);
	const binaryPath = join(binDir, `dprint${extension}`);
	const binaryKey = `dprint-bin-v2-${target.cacheKey}-${version}`;
	const useActionsCache = cacheEnabled && isCacheAvailable();
	debug(`Binary install directory: ${binDir}`);
	debug(`Binary cache key: ${binaryKey}; Actions cache enabled: ${useActionsCache}`);

	if (cacheEnabled && !useActionsCache) warning("GitHub Actions cache is unavailable; downloading dprint directly");
	if (useActionsCache) {
		try {
			const hitKey = await restoreCache([binDir], binaryKey);
			debug(`Binary cache restore result: ${hitKey ?? "miss"}; binary present: ${existsSync(binaryPath)}`);
			if (hitKey !== undefined && existsSync(binaryPath)) {
				info(`Cache hit: dprint ${version} from actions/cache`);
				return await finalize(binaryPath, true, target.cacheKey);
			}
		} catch (error) {
			warning(`Failed to restore dprint binary cache: ${describe(error)}`);
		}
	}

	release ??= await resolveRelease(version, token);
	debug(`Published release assets: ${release.assets.map(candidate => candidate.name).join(", ")}`);
	let asset: ReleaseAsset;
	try {
		asset = selectReleaseAsset(release.assets, target);
	} catch (error) {
		throw new Error(`dprint ${version} cannot be installed on ${target.cacheKey}: ${describe(error)}`);
	}
	info(`Selected release asset: ${asset.name}`);
	const expectedChecksum = await resolveReleaseAssetChecksum(version, asset, release.assets);
	info(`Downloading dprint ${version}`);
	const zipPath = await downloadTool(asset.browser_download_url);
	await verifyReleaseAsset(zipPath, asset, expectedChecksum);
	info(`Verified SHA-256 checksum for ${asset.name}`);
	const extractedDir = await extractZip(zipPath);
	const extractedBinary = join(extractedDir, `dprint${extension}`);
	debug(`Extracted ${asset.name} to ${extractedDir}`);
	if (target.os !== "win32") await exec("chmod", ["+x", extractedBinary]);

	await mkdirP(binDir);
	await cp(extractedBinary, binaryPath);
	if (cacheEnabled) {
		await cacheDir(extractedDir, "dprint", version, target.cacheKey);
		debug(`Stored dprint ${version} in tool-cache for ${target.cacheKey}`);
	}

	if (useActionsCache) {
		saveState("BIN_CACHE_KEY", binaryKey);
		saveState("BIN_CACHE_DIR", binDir);
	}
	return await finalize(binaryPath, false, target.cacheKey);
}

async function finalize(
	binaryPath: string,
	cacheHit: boolean,
	platformKey: string,
): Promise<{ version: string; location: string; cacheHit: boolean; platformKey: string }> {
	addPath(dirname(binaryPath));
	debug(`Verifying installed binary: ${binaryPath} --version`);
	let output = "";
	await exec(binaryPath, ["--version"], {
		listeners: { stdout: (data: Buffer) => output += data.toString() },
	});
	const version = output.trim().split(" ").pop() ?? output.trim();
	setOutput("version", version);
	setOutput("location", binaryPath);
	setOutput("cache-hit", cacheHit);
	info(`dprint ${version} ready at ${binaryPath}`);
	return { version, location: binaryPath, cacheHit, platformKey };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
