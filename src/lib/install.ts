import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "node:process";

import { addPath, debug, info, setOutput } from "#lib/actions";
import { resolveReleaseAssetChecksum, verifyReleaseAsset } from "#lib/checksum";
import { ACTION_OUTPUT, DPRINT, ENVIRONMENT, RUNTIME_OS } from "#lib/contracts";
import { describeError } from "#lib/error";
import { execFileAsync } from "#lib/exec";
import { resolveRuntimePlatform, selectReleaseAsset } from "#lib/platform";
import { downloadTool, extractZip } from "#lib/tool";
import type { Release, ReleaseAsset } from "#lib/version";
import { resolveRelease, specifiedVersion } from "#lib/version";

const installDir = (): string => env[ENVIRONMENT.dprintInstallDirectory] ?? join(homedir(), `.${DPRINT.name}`);

export const installDprint = async (versionInput: string, token: string): Promise<{
	version: string;
	location: string;
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

	const binDir = join(installDir(), "bin", target.cacheKey, version);
	const binaryPath = join(binDir, `${DPRINT.name}${extension}`);
	debug(`Binary install directory: ${binDir}`);

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
	return await finalize(binaryPath);
};

const finalize = async (binaryPath: string): Promise<{ version: string; location: string }> => {
	addPath(dirname(binaryPath));
	debug(`Verifying installed binary: ${binaryPath} ${DPRINT.command.version}`);
	const { stdout } = await execFileAsync(binaryPath, [DPRINT.command.version]);
	const output = String(stdout);
	const version = output.trim().split(" ").pop() ?? output.trim();
	setOutput(ACTION_OUTPUT.version, version);
	setOutput(ACTION_OUTPUT.location, binaryPath);
	info(`dprint ${version} ready at ${binaryPath}`);
	return { version, location: binaryPath };
};
