import { family, GLIBC, MUSL } from "detect-libc";
import { arch, endianness, platform } from "node:os";

import type { ReleaseAsset } from "#lib/version";

export type Libc = "gnu" | "musl";

export interface RuntimePlatform {
	os: string;
	cpu: string;
	libc?: Libc;
	byteOrder: "BE" | "LE";
	cacheKey: string;
}

interface RuntimePlatformOptions {
	os?: string;
	cpu?: string;
	libc?: Libc;
	byteOrder?: "BE" | "LE";
	detectLibc?: () => Promise<string | null>;
}

function architectureNames(cpu: string, byteOrder: "BE" | "LE"): string[] {
	if (cpu === "x64") return ["x86_64"];
	if (cpu === "arm64") return ["aarch64"];
	if (cpu === "riscv64") return ["riscv64gc", "riscv64"];
	if (cpu === "loong64") return ["loongarch64", "loong64"];
	if (cpu === "ppc64" && byteOrder === "LE") return ["powerpc64le"];
	return [cpu];
}

function platformNames(os: string, libc?: Libc): string[] {
	if (os === "win32") return ["pc-windows-msvc"];
	if (os === "darwin") return ["apple-darwin"];
	if (os === "android") return ["linux-android"];
	if (os === "linux" && libc !== undefined) return [`unknown-linux-${libc}`];
	return [];
}

export async function resolveRuntimePlatform(options: RuntimePlatformOptions = {}): Promise<RuntimePlatform> {
	const os = options.os ?? platform();
	const cpu = options.cpu ?? arch();
	const byteOrder = options.byteOrder ?? endianness();
	let libc = options.libc;
	if (os === "linux" && libc === undefined) {
		const detected = await (options.detectLibc ?? family)();
		if (detected === GLIBC) libc = "gnu";
		else if (detected === MUSL) libc = "musl";
		else throw new Error("Could not determine whether this Linux runner uses GNU libc or musl");
	}

	const architecture = architectureNames(cpu, byteOrder)[0] ?? cpu;
	const targetPlatform = platformNames(os, libc)[0] ?? os;
	return { os, cpu, libc, byteOrder, cacheKey: `${architecture}-${targetPlatform}` };
}

export function selectReleaseAsset(assets: readonly ReleaseAsset[], target: RuntimePlatform): ReleaseAsset {
	const architectures = architectureNames(target.cpu, target.byteOrder);
	const platforms = platformNames(target.os, target.libc);
	const candidates = architectures.flatMap(architecture =>
		platforms.map(targetPlatform => `dprint-${architecture}-${targetPlatform}.zip`)
	);
	const asset = candidates.map(name => assets.find(candidate => candidate.name === name)).find(Boolean);
	if (asset !== undefined) return asset;

	const published = assets.filter(candidate => candidate.name.endsWith(".zip")).map(candidate => candidate.name).sort();
	throw new Error(
		`No dprint release asset matches ${target.os}-${target.cpu}. Tried: ${
			candidates.join(", ") || "none"
		}. Published ZIPs: ${published.join(", ") || "none"}`,
	);
}
