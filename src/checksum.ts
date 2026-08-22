import { downloadTool } from "@actions/tool-cache";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ReleaseAsset } from "./version.ts";

function digestFromAsset(asset: ReleaseAsset): string | undefined {
	const match = asset.digest?.match(/^sha256:([0-9a-f]{64})$/iu);
	return match?.[1]?.toLowerCase();
}

export function checksumFromManifest(manifest: string, assetName: string): string | undefined {
	for (const line of manifest.split(/\r?\n/u)) {
		const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/iu);
		if (match?.[2] === assetName) return match[1]?.toLowerCase();
	}
	return undefined;
}

type Download = (url: string) => Promise<string>;

async function expectedChecksum(
	asset: ReleaseAsset,
	assets: readonly ReleaseAsset[],
	download: Download,
): Promise<string> {
	const digest = digestFromAsset(asset);
	if (digest !== undefined) return digest;

	const manifestAsset = assets.find(candidate => candidate.name === "SHASUMS256.txt");
	if (manifestAsset === undefined) {
		throw new Error(`Release provides neither a SHA-256 digest for ${asset.name} nor SHASUMS256.txt`);
	}
	const manifestPath = await download(manifestAsset.browser_download_url);
	const checksum = checksumFromManifest(await readFile(manifestPath, "utf8"), asset.name);
	if (checksum === undefined) throw new Error(`SHASUMS256.txt has no checksum for ${asset.name}`);
	return checksum;
}

async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

export async function verifyReleaseAsset(
	archivePath: string,
	asset: ReleaseAsset,
	assets: readonly ReleaseAsset[],
	download: Download = downloadTool,
): Promise<void> {
	const expected = await expectedChecksum(asset, assets, download);
	const actual = await sha256(archivePath);
	if (actual !== expected) {
		throw new Error(`SHA-256 mismatch for ${asset.name}: expected ${expected}, got ${actual}`);
	}
}
