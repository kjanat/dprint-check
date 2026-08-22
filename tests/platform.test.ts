import { describe, expect, test } from "bun:test";
import { selectReleaseAsset } from "../src/platform.ts";
import type { ReleaseAsset } from "../src/version.ts";

function assets(...names: string[]): ReleaseAsset[] {
	return names.map(name => ({ name, browser_download_url: `https://example.com/${name}`, digest: null }));
}

const releaseAssets = assets(
	"dprint-aarch64-apple-darwin.zip",
	"dprint-aarch64-linux-android.zip",
	"dprint-aarch64-pc-windows-msvc.zip",
	"dprint-aarch64-unknown-linux-gnu.zip",
	"dprint-loongarch64-unknown-linux-gnu.zip",
	"dprint-powerpc64le-unknown-linux-musl.zip",
	"dprint-riscv64gc-unknown-linux-gnu.zip",
	"dprint-x86_64-apple-darwin.zip",
	"dprint-x86_64-pc-windows-msvc-installer.exe",
	"dprint-x86_64-pc-windows-msvc.zip",
	"dprint-x86_64-unknown-linux-musl.zip",
);

describe("selectReleaseAsset", () => {
	test("selects published macOS and Windows ZIPs for each architecture", async () => {
		expect((await selectReleaseAsset(releaseAssets, "darwin", "x64")).name)
			.toBe("dprint-x86_64-apple-darwin.zip");
		expect((await selectReleaseAsset(releaseAssets, "darwin", "arm64")).name)
			.toBe("dprint-aarch64-apple-darwin.zip");
		expect((await selectReleaseAsset(releaseAssets, "win32", "x64")).name)
			.toBe("dprint-x86_64-pc-windows-msvc.zip");
		expect((await selectReleaseAsset(releaseAssets, "win32", "arm64")).name)
			.toBe("dprint-aarch64-pc-windows-msvc.zip");
	});

	test("discovers newer Linux and Android release targets", async () => {
		expect((await selectReleaseAsset(releaseAssets, "linux", "riscv64", "gnu")).name)
			.toBe("dprint-riscv64gc-unknown-linux-gnu.zip");
		expect((await selectReleaseAsset(releaseAssets, "linux", "loong64", "gnu")).name)
			.toBe("dprint-loongarch64-unknown-linux-gnu.zip");
		expect((await selectReleaseAsset(releaseAssets, "linux", "ppc64", "musl", "LE")).name)
			.toBe("dprint-powerpc64le-unknown-linux-musl.zip");
		expect((await selectReleaseAsset(releaseAssets, "android", "arm64")).name)
			.toBe("dprint-aarch64-linux-android.zip");
	});

	test("reports attempted and published assets when no match exists", async () => {
		await expect(selectReleaseAsset(releaseAssets, "freebsd", "x64")).rejects.toThrow(
			"No dprint release asset matches freebsd-x64",
		);
	});
});
