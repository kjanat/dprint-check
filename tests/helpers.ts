import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach } from "node:test";

import { createTemporaryDirectory } from "#lib/temp";
import type { ReleaseAsset } from "#lib/version";

export const TEST_DPRINT_VERSION = "0.56.1";
export const TEST_DPRINT_ASSET = "dprint.zip";
export const TEST_DPRINT_BINARY = "/tools/dprint";

export const releaseAsset = (name: string, digest: string | null = null): ReleaseAsset => ({
	name,
	browser_download_url: `https://example.com/${name}`,
	digest,
});

export const useTestContext = () => {
	const directories: string[] = [];
	const environment = new Map<string, string | undefined>();

	const context = {
		setEnvironment(name: string, value: string | undefined): void {
			if (!environment.has(name)) environment.set(name, process.env[name]);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		},
		async temporaryDirectory(prefix: string): Promise<string> {
			const path = await createTemporaryDirectory(tmpdir(), prefix);
			directories.push(path);
			return path;
		},
		async cleanup(): Promise<void> {
			for (const [name, value] of environment) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			environment.clear();
			await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
		},
	};
	afterEach(context.cleanup);
	return context;
};
