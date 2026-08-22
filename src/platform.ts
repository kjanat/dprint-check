import { arch, endianness, platform } from "node:os";
import { execFileAsync } from "./exec.ts";
import type { ReleaseAsset } from "./version.ts";

async function detectLibc(): Promise<"gnu" | "musl"> {
	try {
		const { stdout } = await execFileAsync("ldd", ["--version"], { timeout: 5_000 });
		return stdout.toLowerCase().includes("musl") ? "musl" : "gnu";
	} catch (error: unknown) {
		if (
			error !== null && typeof error === "object" && "stderr" in error
			&& typeof (error as { stderr: unknown }).stderr === "string"
		) return (error as { stderr: string }).stderr.toLowerCase().includes("musl") ? "musl" : "gnu";
		return "gnu";
	}
}

function architectureNames(cpu: string, byteOrder: "BE" | "LE"): string[] {
	if (cpu === "x64") return ["x86_64"];
	if (cpu === "arm64") return ["aarch64"];
	if (cpu === "riscv64") return ["riscv64gc", "riscv64"];
	if (cpu === "loong64") return ["loongarch64", "loong64"];
	if (cpu === "ppc64" && byteOrder === "LE") return ["powerpc64le"];
	return [cpu];
}

async function platformNames(os: string, libc?: "gnu" | "musl"): Promise<string[]> {
	if (os === "win32") return ["pc-windows-msvc"];
	if (os === "darwin") return ["apple-darwin"];
	if (os === "android") return ["linux-android"];
	if (os === "linux") return [`unknown-linux-${libc ?? await detectLibc()}`];
	return [];
}

export async function selectReleaseAsset(
	assets: readonly ReleaseAsset[],
	os = platform(),
	cpu = arch(),
	libc?: "gnu" | "musl",
	byteOrder = endianness(),
): Promise<ReleaseAsset> {
	const architectures = architectureNames(cpu, byteOrder);
	const platforms = await platformNames(os, libc);
	const candidates = architectures.flatMap(architecture =>
		platforms.map(targetPlatform => `dprint-${architecture}-${targetPlatform}.zip`)
	);
	const asset = candidates.map(name => assets.find(candidate => candidate.name === name)).find(Boolean);
	if (asset !== undefined) return asset;

	const published = assets.filter(candidate => candidate.name.endsWith(".zip")).map(candidate => candidate.name).sort();
	throw new Error(
		`No dprint release asset matches ${os}-${cpu}. Tried: ${candidates.join(", ") || "none"}. Published ZIPs: ${
			published.join(", ") || "none"
		}`,
	);
}
