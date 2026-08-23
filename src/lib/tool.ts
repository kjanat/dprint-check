import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { debug } from "#lib/actions";
import { execFileAsync } from "#lib/exec";

const DOWNLOAD_ATTEMPTS = 3;

interface DownloadOptions {
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	sleep?: (milliseconds: number) => Promise<void>;
}

function temporaryRoot(): string {
	return env["RUNNER_TEMP"] ?? tmpdir();
}

async function temporaryDirectory(prefix: string): Promise<string> {
	const root = temporaryRoot();
	await mkdir(root, { recursive: true });
	return await mkdtemp(join(root, prefix));
}

function toolPath(tool: string, version: string, architecture: string): string | undefined {
	const root = env["RUNNER_TOOL_CACHE"];
	return root === undefined || root === "" ? undefined : join(root, tool, version, architecture);
}

export function findTool(tool: string, version: string, architecture: string): string {
	const path = toolPath(tool, version, architecture);
	if (path !== undefined && existsSync(path) && existsSync(`${path}.complete`)) return path;
	return "";
}

export async function cacheToolDirectory(
	sourceDirectory: string,
	tool: string,
	version: string,
	architecture: string,
): Promise<string> {
	const destination = toolPath(tool, version, architecture);
	if (destination === undefined) {
		debug("RUNNER_TOOL_CACHE is unavailable; skipping tool-cache storage");
		return "";
	}
	await rm(destination, { recursive: true, force: true });
	await rm(`${destination}.complete`, { force: true });
	await mkdir(destination, { recursive: true });
	for (const entry of await readdir(sourceDirectory)) {
		await cp(join(sourceDirectory, entry), join(destination, entry), { recursive: true });
	}
	await writeFile(`${destination}.complete`, "");
	return destination;
}

function retryableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

export async function downloadTool(url: string, options: DownloadOptions = {}): Promise<string> {
	const fetch = options.fetch ?? globalThis.fetch;
	const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
	const directory = await temporaryDirectory("dprint-download-");
	const destination = join(directory, "download");
	let lastError: unknown;
	for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
		let response: Response;
		try {
			response = await fetch(url);
		} catch (error) {
			lastError = error;
			if (attempt < DOWNLOAD_ATTEMPTS) await sleep(attempt * 1000);
			continue;
		}
		if (!response.ok || response.body === null) {
			lastError = new Error(`Download failed with HTTP ${response.status}`);
			if (!retryableStatus(response.status)) break;
			if (attempt < DOWNLOAD_ATTEMPTS) await sleep(attempt * 1000);
			continue;
		}
		await mkdir(dirname(destination), { recursive: true });
		await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
		return destination;
	}
	await rm(directory, { recursive: true, force: true });
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function powershellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''").replace(/["\r\n]/gu, "")}'`;
}

export async function extractZip(archive: string): Promise<string> {
	const destination = await temporaryDirectory("dprint-extract-");
	if (process.platform === "win32") {
		const command = `Expand-Archive -LiteralPath ${powershellLiteral(archive)} -DestinationPath ${
			powershellLiteral(destination)
		} -Force`;
		try {
			await execFileAsync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			await execFileAsync("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]);
		}
	} else {
		await execFileAsync("unzip", ["-o", "-q", archive, "-d", destination]);
	}
	return destination;
}
