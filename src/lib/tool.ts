import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { debug } from "#lib/actions";
import { execFileAsync } from "#lib/exec";
import { requestWithRetry } from "#lib/http";
import type { RetryOptions } from "#lib/http";
import { createTemporaryDirectory } from "#lib/temp";

type DownloadOptions = Pick<RetryOptions, "fetch" | "sleep">;

const temporaryRoot = (): string => env["RUNNER_TEMP"] ?? tmpdir();

const temporaryDirectory = (prefix: string): Promise<string> => createTemporaryDirectory(temporaryRoot(), prefix);

const toolPath = (tool: string, version: string, architecture: string): string | undefined => {
	const root = env["RUNNER_TOOL_CACHE"];
	return root === undefined || root === "" ? undefined : join(root, tool, version, architecture);
};

export const findTool = (tool: string, version: string, architecture: string): string => {
	const path = toolPath(tool, version, architecture);
	if (path !== undefined && existsSync(path) && existsSync(`${path}.complete`)) return path;
	return "";
};

export const cacheToolDirectory = async (
	sourceDirectory: string,
	tool: string,
	version: string,
	architecture: string,
): Promise<string> => {
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
};

export const downloadTool = async (url: string, options: DownloadOptions = {}): Promise<string> => {
	const directory = await temporaryDirectory("dprint-download-");
	const destination = join(directory, "download");
	try {
		const response = await requestWithRetry(url, undefined, options);
		if (!response.ok || response.body === null) {
			throw new Error(`Download failed with HTTP ${response.status}`);
		}
		await mkdir(dirname(destination), { recursive: true });
		await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
		return destination;
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
};

const powershellLiteral = (value: string): string => `'${value.replaceAll("'", "''").replace(/["\r\n]/gu, "")}'`;

export const extractZip = async (archive: string): Promise<string> => {
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
};
