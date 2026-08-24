import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

import { DPRINT } from "#lib/contracts";
import { downloadTool } from "#lib/tool";
import type { ReleaseAsset } from "#lib/version";

const digestFromAsset = (asset: ReleaseAsset): string | undefined => {
	const prefix = `${DPRINT.sha256Algorithm}:`;
	if (asset.digest?.startsWith(prefix) !== true) return undefined;
	const digest = asset.digest.slice(prefix.length);
	return /^[0-9a-f]{64}$/iu.test(digest) ? digest.toLowerCase() : undefined;
};

export const checksumFromManifest = (manifest: string, assetName: string): string | undefined => {
	for (const line of manifest.split(/\r?\n/u)) {
		const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/iu);
		if (match?.[2] === assetName) return match[1]?.toLowerCase();
	}
	return undefined;
};

type Download = (url: string) => Promise<string>;

export const resolveReleaseAssetChecksum = async (
	releaseTag: string,
	asset: ReleaseAsset,
	assets: readonly ReleaseAsset[],
	download: Download = downloadTool,
): Promise<string> => {
	const digest = digestFromAsset(asset);
	if (digest !== undefined) return digest;

	const manifestAsset = assets.find(candidate => candidate.name === DPRINT.checksumAsset);
	if (manifestAsset === undefined) {
		throw new Error(
			`dprint ${releaseTag} cannot be securely installed: the release provides neither a SHA-256 digest for ${asset.name} nor ${DPRINT.checksumAsset}`,
		);
	}
	const manifestPath = await download(manifestAsset.browser_download_url);
	const checksum = checksumFromManifest(await readFile(manifestPath, "utf8"), asset.name);
	if (checksum === undefined) {
		throw new Error(
			`dprint ${releaseTag} cannot be securely installed: ${DPRINT.checksumAsset} has no checksum for ${asset.name}`,
		);
	}
	return checksum;
};

const sha256 = async (path: string): Promise<string> => {
	const hash = createHash(DPRINT.sha256Algorithm);
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
};

export const verifyReleaseAsset = async (
	archivePath: string,
	asset: ReleaseAsset,
	expectedChecksum: string,
): Promise<void> => {
	const actual = await sha256(archivePath);
	if (actual !== expectedChecksum) {
		throw new Error(`SHA-256 mismatch for ${asset.name}: expected ${expectedChecksum}, got ${actual}`);
	}
};
