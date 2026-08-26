import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { ENVIRONMENT, RUNTIME_OS } from "#lib/contracts";
import { execFileAsync } from "#lib/exec";
import { requestWithRetry } from "#lib/http";
import type { RetryTransportOptions } from "#lib/http";
import { createTemporaryDirectory } from "#lib/temp";

type DownloadOptions = RetryTransportOptions;

const POWERSHELL_ARGUMENTS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] as const;

const temporaryRoot = (): string => env[ENVIRONMENT.runnerTemporaryDirectory] ?? tmpdir();

const temporaryDirectory = (prefix: string): Promise<string> => createTemporaryDirectory(temporaryRoot(), prefix);

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
	if (process.platform === RUNTIME_OS.windows) {
		const a = powershellLiteral(archive);
		const d = powershellLiteral(destination);
		const command = `Expand-Archive -LiteralPath ${a} -DestinationPath ${d} -Force`;
		try {
			await execFileAsync("pwsh", [...POWERSHELL_ARGUMENTS, command]);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			await execFileAsync("powershell", [...POWERSHELL_ARGUMENTS, command]);
		}
	} else {
		await execFileAsync("unzip", ["-o", "-q", archive, "-d", destination]);
	}
	return destination;
};
