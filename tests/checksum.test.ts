import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";

import { checksumFromManifest, resolveReleaseAssetChecksum, verifyReleaseAsset } from "#lib/checksum";
import { DPRINT } from "#lib/contracts";
import { releaseAsset, TEST_DPRINT_ASSET, TEST_DPRINT_VERSION, useTestContext } from "#test/helpers";

const context = useTestContext();

describe("checksumFromManifest", () => {
	const hash = "a".repeat(64);
	const cases = [
		{ name: "GNU entry", manifest: `${hash}  dprint-x86_64.zip\n`, assetName: "dprint-x86_64.zip", expected: hash },
		{
			name: "binary-mode entry",
			manifest: `${hash} *dprint-aarch64.zip\n`,
			assetName: "dprint-aarch64.zip",
			expected: hash,
		},
		{
			name: "different asset",
			manifest: `${hash}  dprint-x86_64.zip\n`,
			assetName: TEST_DPRINT_ASSET,
			expected: undefined,
		},
	];

	for (const { name, manifest, assetName, expected } of cases) {
		test(`parses ${name}`, () => {
			assert.strictEqual(checksumFromManifest(manifest, assetName), expected);
		});
	}
});

describe("verifyReleaseAsset", () => {
	test("uses the digest supplied by GitHub for current release assets", async t => {
		const directory = await context.temporaryDirectory("dprint-checksum-");
		const archive = join(directory, TEST_DPRINT_ASSET);
		await writeFile(archive, "verified archive");
		const digest = createHash(DPRINT.sha256Algorithm).update("verified archive").digest("hex");
		const asset = releaseAsset(TEST_DPRINT_ASSET, `${DPRINT.sha256Algorithm}:${digest}`);
		const download = t.mock.fn(async () => {
			throw new Error("checksum manifest should not be downloaded");
		});

		const expected = await resolveReleaseAssetChecksum(TEST_DPRINT_VERSION, asset, [asset], download);
		await assert.doesNotReject(verifyReleaseAsset(archive, asset, expected));
		assert.strictEqual(download.mock.callCount(), 0);
	});

	test("rejects a mismatched GitHub digest", async () => {
		const directory = await context.temporaryDirectory("dprint-checksum-");
		const archive = join(directory, TEST_DPRINT_ASSET);
		await writeFile(archive, "unverified archive");
		const expectedChecksum = "0".repeat(64);
		const actualChecksum = createHash(DPRINT.sha256Algorithm).update("unverified archive").digest("hex");
		const asset = releaseAsset(TEST_DPRINT_ASSET, `${DPRINT.sha256Algorithm}:${expectedChecksum}`);

		const expected = await resolveReleaseAssetChecksum(TEST_DPRINT_VERSION, asset, [asset]);
		await assert.rejects(verifyReleaseAsset(archive, asset, expected), {
			message: `SHA-256 mismatch for ${TEST_DPRINT_ASSET}: expected ${expectedChecksum}, got ${actualChecksum}`,
		});
	});

	test("downloads the checksum manifest for older release assets", async t => {
		const directory = await context.temporaryDirectory("dprint-checksum-");
		const archive = join(directory, TEST_DPRINT_ASSET);
		const manifest = join(directory, DPRINT.checksumAsset);
		await writeFile(archive, "older archive");
		const digest = createHash(DPRINT.sha256Algorithm).update("older archive").digest("hex");
		await writeFile(manifest, `${digest}  ${TEST_DPRINT_ASSET}\n`);
		const asset = releaseAsset(TEST_DPRINT_ASSET);
		const checksumAsset = releaseAsset(DPRINT.checksumAsset);
		const download = t.mock.fn(async () => manifest);

		const expected = await resolveReleaseAssetChecksum(
			"0.49.1",
			asset,
			[asset, checksumAsset],
			download,
		);
		assert.strictEqual(download.mock.callCount(), 1);
		assert.deepStrictEqual(download.mock.calls[0]?.arguments, [checksumAsset.browser_download_url]);
		await assert.doesNotReject(verifyReleaseAsset(archive, asset, expected));
	});

	test("rejects unverifiable historical releases before downloading anything", async t => {
		const asset = releaseAsset(TEST_DPRINT_ASSET);
		const download = t.mock.fn(async () => {
			throw new Error("download should not run");
		});

		await assert.rejects(
			resolveReleaseAssetChecksum("0.13.1", asset, [asset], download),
			error => error instanceof Error && error.message.includes("dprint 0.13.1 cannot be securely installed"),
		);
		assert.strictEqual(download.mock.callCount(), 0);
	});

	test("rejects a checksum manifest without the selected asset", async t => {
		const directory = await context.temporaryDirectory("dprint-checksum-");
		const manifest = join(directory, DPRINT.checksumAsset);
		await writeFile(manifest, `${"a".repeat(64)}  another-asset.zip\n`);
		const asset = releaseAsset(TEST_DPRINT_ASSET);
		const checksumAsset = releaseAsset(DPRINT.checksumAsset);
		const download = t.mock.fn(async () => manifest);

		await assert.rejects(
			resolveReleaseAssetChecksum("0.49.1", asset, [asset, checksumAsset], download),
			error =>
				error instanceof Error
				&& error.message.includes(`${DPRINT.checksumAsset} has no checksum for ${TEST_DPRINT_ASSET}`),
		);
		assert.strictEqual(download.mock.callCount(), 1);
		assert.deepStrictEqual(download.mock.calls[0]?.arguments, [checksumAsset.browser_download_url]);
	});
});
