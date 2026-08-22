import { afterEach, describe, expect, test } from "bun:test";
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

		const expected = await resolveReleaseAssetChecksum("0.56.1", releaseAsset, [releaseAsset]);
		expect(verifyReleaseAsset(archive, releaseAsset, expected)).resolves.toBeUndefined();
	});

	test("rejects a mismatched GitHub digest", async () => {
		const directory = await mkdtemp(join(tmpdir(), "dprint-checksum-"));
		temporaryDirectories.push(directory);
		const archive = join(directory, "dprint.zip");
		await writeFile(archive, "unverified archive");
		const releaseAsset = asset("dprint.zip", `sha256:${"0".repeat(64)}`);

		const expected = await resolveReleaseAssetChecksum("0.56.1", releaseAsset, [releaseAsset]);
		expect(verifyReleaseAsset(archive, releaseAsset, expected)).rejects.toThrow("SHA-256 mismatch");
	});

	test("downloads the checksum manifest for older release assets", async () => {
		expect.assertions(2);
		const directory = await mkdtemp(join(tmpdir(), "dprint-checksum-"));
		temporaryDirectories.push(directory);
		const archive = join(directory, "dprint.zip");
		const manifest = join(directory, "SHASUMS256.txt");
		await writeFile(archive, "older archive");
		const digest = createHash("sha256").update("older archive").digest("hex");
		await writeFile(manifest, `${digest}  dprint.zip\n`);
		const releaseAsset = asset("dprint.zip", null);
		const checksumAsset = asset("SHASUMS256.txt", null);

		const expected = await resolveReleaseAssetChecksum(
			"0.49.1",
			releaseAsset,
			[releaseAsset, checksumAsset],
			async url => {
				expect(url).toBe(checksumAsset.browser_download_url);
				return manifest;
			},
		);
		expect(verifyReleaseAsset(archive, releaseAsset, expected)).resolves.toBeUndefined();
	});

	test("rejects unverifiable historical releases before downloading anything", async () => {
		expect.assertions(2);
		const releaseAsset = asset("dprint.zip", null);
		let downloadCalled = false;

		expect(resolveReleaseAssetChecksum("0.13.1", releaseAsset, [releaseAsset], async () => {
			downloadCalled = true;
			throw new Error("download should not run");
		})).rejects.toThrow("dprint 0.13.1 cannot be securely installed");
		expect(downloadCalled).toBeFalse();
	});
});
