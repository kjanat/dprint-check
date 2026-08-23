import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checksumFromManifest, resolveReleaseAssetChecksum, verifyReleaseAsset } from "#lib/checksum";
import type { ReleaseAsset } from "#lib/version";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function asset(name: string, digest: string | null): ReleaseAsset {
	return { name, browser_download_url: `https://example.com/${name}`, digest };
}

describe("checksumFromManifest", () => {
	const hash = "a".repeat(64);
	test.each([
		{ name: "GNU entry", manifest: `${hash}  dprint-x86_64.zip\n`, assetName: "dprint-x86_64.zip", expected: hash },
		{
			name: "binary-mode entry",
			manifest: `${hash} *dprint-aarch64.zip\n`,
			assetName: "dprint-aarch64.zip",
			expected: hash,
		},
		{ name: "different asset", manifest: `${hash}  dprint-x86_64.zip\n`, assetName: "dprint.zip", expected: undefined },
	])("parses $name", ({ manifest, assetName, expected }) => {
		expect(checksumFromManifest(manifest, assetName)).toBe(expected);
	});
});

describe("verifyReleaseAsset", () => {
	test("uses the digest supplied by GitHub for current release assets", async () => {
		const directory = await mkdtemp(join(tmpdir(), "dprint-checksum-"));
		temporaryDirectories.push(directory);
		const archive = join(directory, "dprint.zip");
		await writeFile(archive, "verified archive");
		const digest = createHash("sha256").update("verified archive").digest("hex");
		const releaseAsset = asset("dprint.zip", `sha256:${digest}`);
		const download = mock(async () => {
			throw new Error("checksum manifest should not be downloaded");
		});

		const expected = await resolveReleaseAssetChecksum("0.56.1", releaseAsset, [releaseAsset], download);
		expect(verifyReleaseAsset(archive, releaseAsset, expected)).resolves.toBeUndefined();
		expect(download).not.toHaveBeenCalled();
	});

	test("rejects a mismatched GitHub digest", async () => {
		const directory = await mkdtemp(join(tmpdir(), "dprint-checksum-"));
		temporaryDirectories.push(directory);
		const archive = join(directory, "dprint.zip");
		await writeFile(archive, "unverified archive");
		const expectedChecksum = "0".repeat(64);
		const actualChecksum = createHash("sha256").update("unverified archive").digest("hex");
		const releaseAsset = asset("dprint.zip", `sha256:${expectedChecksum}`);

		const expected = await resolveReleaseAssetChecksum("0.56.1", releaseAsset, [releaseAsset]);
		expect(verifyReleaseAsset(archive, releaseAsset, expected)).rejects.toThrow(
			`SHA-256 mismatch for dprint.zip: expected ${expectedChecksum}, got ${actualChecksum}`,
		);
	});

	test("downloads the checksum manifest for older release assets", async () => {
		const directory = await mkdtemp(join(tmpdir(), "dprint-checksum-"));
		temporaryDirectories.push(directory);
		const archive = join(directory, "dprint.zip");
		const manifest = join(directory, "SHASUMS256.txt");
		await writeFile(archive, "older archive");
		const digest = createHash("sha256").update("older archive").digest("hex");
		await writeFile(manifest, `${digest}  dprint.zip\n`);
		const releaseAsset = asset("dprint.zip", null);
		const checksumAsset = asset("SHASUMS256.txt", null);
		const download = mock(async () => manifest);

		const expected = await resolveReleaseAssetChecksum(
			"0.49.1",
			releaseAsset,
			[releaseAsset, checksumAsset],
			download,
		);
		expect(download).toHaveBeenCalledTimes(1);
		expect(download).toHaveBeenCalledWith(checksumAsset.browser_download_url);
		expect(verifyReleaseAsset(archive, releaseAsset, expected)).resolves.toBeUndefined();
	});

	test("rejects unverifiable historical releases before downloading anything", async () => {
		const releaseAsset = asset("dprint.zip", null);
		const download = mock(async () => {
			throw new Error("download should not run");
		});

		expect(resolveReleaseAssetChecksum("0.13.1", releaseAsset, [releaseAsset], download)).rejects.toThrow(
			"dprint 0.13.1 cannot be securely installed",
		);
		expect(download).not.toHaveBeenCalled();
	});

	test("rejects a checksum manifest without the selected asset", async () => {
		const directory = await mkdtemp(join(tmpdir(), "dprint-checksum-"));
		temporaryDirectories.push(directory);
		const manifest = join(directory, "SHASUMS256.txt");
		await writeFile(manifest, `${"a".repeat(64)}  another-asset.zip\n`);
		const releaseAsset = asset("dprint.zip", null);
		const checksumAsset = asset("SHASUMS256.txt", null);
		const download = mock(async () => manifest);

		expect(resolveReleaseAssetChecksum("0.49.1", releaseAsset, [releaseAsset, checksumAsset], download)).rejects
			.toThrow("SHASUMS256.txt has no checksum for dprint.zip");
		expect(download).toHaveBeenCalledTimes(1);
		expect(download).toHaveBeenCalledWith(checksumAsset.browser_download_url);
	});
});
