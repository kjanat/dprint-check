import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksumFromManifest, verifyReleaseAsset } from "../src/checksum.ts";
import type { ReleaseAsset } from "../src/version.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function asset(name: string, digest: string | null): ReleaseAsset {
	return { name, browser_download_url: `https://example.com/${name}`, digest };
}

describe("checksumFromManifest", () => {
	test("finds GNU and binary-mode checksum entries by exact asset name", () => {
		const hash = "a".repeat(64);
		expect(checksumFromManifest(`${hash}  dprint-x86_64.zip\n`, "dprint-x86_64.zip")).toBe(hash);
		expect(checksumFromManifest(`${hash} *dprint-aarch64.zip\n`, "dprint-aarch64.zip")).toBe(hash);
		expect(checksumFromManifest(`${hash}  dprint-x86_64.zip\n`, "dprint.zip")).toBeUndefined();
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

		await expect(verifyReleaseAsset(archive, releaseAsset, [releaseAsset])).resolves.toBeUndefined();
	});

	test("rejects a mismatched GitHub digest", async () => {
		const directory = await mkdtemp(join(tmpdir(), "dprint-checksum-"));
		temporaryDirectories.push(directory);
		const archive = join(directory, "dprint.zip");
		await writeFile(archive, "unverified archive");
		const releaseAsset = asset("dprint.zip", `sha256:${"0".repeat(64)}`);

		await expect(verifyReleaseAsset(archive, releaseAsset, [releaseAsset])).rejects.toThrow("SHA-256 mismatch");
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

		await expect(verifyReleaseAsset(archive, releaseAsset, [releaseAsset, checksumAsset], async url => {
			expect(url).toBe(checksumAsset.browser_download_url);
			return manifest;
		})).resolves.toBeUndefined();
	});
});
