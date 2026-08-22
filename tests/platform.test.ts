import { describe, expect, test } from "bun:test";

import { selectReleaseAsset } from "#lib/platform";
import type { ReleaseAsset } from "#lib/version";

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
	test.each(
		[
			{
				label: "macOS x64",
				os: "darwin",
				cpu: "x64",
				libc: undefined,
				byteOrder: undefined,
				expected: "dprint-x86_64-apple-darwin.zip",
			},
			{
				label: "macOS arm64",
				os: "darwin",
				cpu: "arm64",
				libc: undefined,
				byteOrder: undefined,
				expected: "dprint-aarch64-apple-darwin.zip",
			},
			{
				label: "Windows x64",
				os: "win32",
				cpu: "x64",
				libc: undefined,
				byteOrder: undefined,
				expected: "dprint-x86_64-pc-windows-msvc.zip",
			},
			{
				label: "Windows arm64",
				os: "win32",
				cpu: "arm64",
				libc: undefined,
				byteOrder: undefined,
				expected: "dprint-aarch64-pc-windows-msvc.zip",
			},
			{
				label: "Linux RISC-V GNU",
				os: "linux",
				cpu: "riscv64",
				libc: "gnu",
				byteOrder: undefined,
				expected: "dprint-riscv64gc-unknown-linux-gnu.zip",
			},
			{
				label: "Linux LoongArch GNU",
				os: "linux",
				cpu: "loong64",
				libc: "gnu",
				byteOrder: undefined,
				expected: "dprint-loongarch64-unknown-linux-gnu.zip",
			},
			{
				label: "Linux POWER musl",
				os: "linux",
				cpu: "ppc64",
				libc: "musl",
				byteOrder: "LE",
				expected: "dprint-powerpc64le-unknown-linux-musl.zip",
			},
			{
				label: "Android arm64",
				os: "android",
				cpu: "arm64",
				libc: undefined,
				byteOrder: undefined,
				expected: "dprint-aarch64-linux-android.zip",
			},
		] as const,
	)("selects the published ZIP for $label", async ({ os, cpu, libc, byteOrder, expected }) => {
		expect((await selectReleaseAsset(releaseAssets, os, cpu, libc, byteOrder)).name).toBe(expected);
	});

	test("reports attempted and published assets when no match exists", () => {
		expect(selectReleaseAsset(releaseAssets, "freebsd", "x64")).rejects.toThrow(
			"No dprint release asset matches freebsd-x64",
		);
	});
});
