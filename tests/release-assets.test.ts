import { expect, test } from "bun:test";

import { resolveRuntimePlatform, selectReleaseAsset } from "#lib/platform";
import type { ReleaseAsset } from "#lib/version";
import releaseHistory from "./fixtures/release-assets.json" with { type: "json" };

async function targetForAsset(assetName: string) {
	const match = /^dprint-(?<architecture>x86_64|aarch64|riscv64gc|loongarch64|powerpc64le)-(?<platform>.+)\.zip$/u.exec(
		assetName,
	);
	if (match === null) return undefined;

	const architecture = match.groups?.architecture;
	const platform = match.groups?.platform;
	const cpu = // dprint-ignore
		architecture === "x86_64" ? "x64"
		: architecture === "aarch64" ? "arm64"
		: architecture === "riscv64gc" ? "riscv64"
		: architecture === "loongarch64" ? "loong64"
		: "ppc64";
	const byteOrder = architecture === "powerpc64le" ? "LE" as const : undefined;

	if (platform === "apple-darwin") return await resolveRuntimePlatform({ os: "darwin", cpu, byteOrder });
	if (platform === "pc-windows-msvc") return await resolveRuntimePlatform({ os: "win32", cpu, byteOrder });
	if (platform === "linux-android") return await resolveRuntimePlatform({ os: "android", cpu, byteOrder });
	if (platform === "unknown-linux-gnu") {
		return await resolveRuntimePlatform({ os: "linux", cpu, libc: "gnu", byteOrder });
	}
	if (platform === "unknown-linux-musl") {
		return await resolveRuntimePlatform({ os: "linux", cpu, libc: "musl", byteOrder });
	}
	return undefined;
}

test("selects every historical dprint release ZIP", async () => {
	const failures: string[] = [];
	let checked = 0;

	for (const release of releaseHistory.releases) {
		const assets: ReleaseAsset[] = release.assets.map(asset => ({
			name: asset.name,
			browser_download_url: asset.browser_download_url,
			digest: asset.digest,
		}));
		for (const asset of assets.filter(candidate => candidate.name.endsWith(".zip"))) {
			checked++;
			const target = await targetForAsset(asset.name);
			if (target === undefined) {
				failures.push(`${release.tag_name}: unrecognized asset name ${asset.name}`);
				continue;
			}
			try {
				const selected = selectReleaseAsset(assets, target);
				if (selected.name !== asset.name) {
					failures.push(`${release.tag_name}: selected ${selected.name} instead of ${asset.name}`);
				}
			} catch (error) {
				failures.push(`${release.tag_name}: ${String(error)}`);
			}
		}
	}

	expect(checked).toBeGreaterThan(0);
	expect(failures).toBeEmpty();
});
