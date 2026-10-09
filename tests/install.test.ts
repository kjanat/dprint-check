import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as actions from "#lib/actions";
import { ENVIRONMENT } from "#lib/contracts";
import { resolveRuntimePlatform } from "#lib/platform";
import { parseRepository } from "#lib/repository";
import * as tool from "#lib/tool";
import { useTestContext } from "#test/helpers";

const context = useTestContext();

test("installs each repository and exact tag independently, then reuses its own tool-cache", async t => {
	const root = await context.temporaryDirectory("dprint-check-install-");
	context.setEnvironment(ENVIRONMENT.runnerToolCache, join(root, "tool-cache"));
	context.setEnvironment(ENVIRONMENT.dprintInstallDirectory, join(root, "install"));
	context.setEnvironment(ENVIRONMENT.actionsResultsUrl, undefined);
	const extracted = join(root, "extracted");
	const binaryName = platform() === "win32" ? "dprint.exe" : "dprint";
	await mkdir(extracted);
	await writeFile(join(extracted, binaryName), "test binary");
	const archive = join(root, "archive.zip");
	const archiveContent = "test archive";
	await writeFile(archive, archiveContent);
	const checksum = createHash("sha256").update(archiveContent).digest("hex");
	const target = await resolveRuntimePlatform();
	const requests: string[] = [];
	const downloads: string[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = String(input);
		requests.push(url);
		const match = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\/tags\/(.+)$/u);
		const repository = match?.[1];
		const tag = match?.[2];
		assert.ok(repository !== undefined && tag !== undefined);
		return Response.json({
			tag_name: decodeURIComponent(tag),
			assets: [{
				name: `dprint-${target.cacheKey}.zip`,
				browser_download_url: `https://github.com/${repository}/releases/download/${tag}/dprint-${target.cacheKey}.zip`,
				digest: `sha256:${checksum}`,
			}],
		});
	});
	const actionsMock = {
		cache: false,
		exports: { ...actions, addPath: () => {}, debug: () => {}, info: () => {}, setOutput: () => {} },
	};
	t.mock.module("#lib/actions", actionsMock);
	const execMock = {
		cache: false,
		exports: { execFileAsync: async () => ({ stdout: "dprint 0.56.1\n", stderr: "" }) },
	};
	t.mock.module("#lib/exec", execMock);
	const toolMock = {
		cache: false,
		exports: {
			...tool,
			downloadTool: async (url: string) => {
				downloads.push(url);
				return archive;
			},
			extractZip: async () => extracted,
		},
	};
	t.mock.module("#lib/tool", toolMock);
	const { installDprint } = await import("#lib/install");
	const tag = "v0.56.1-fork.1";
	const fork = await installDprint(tag, true, "");
	const upstream = await installDprint(tag, true, "", parseRepository("dprint/dprint"));
	const caseTag = await installDprint(tag.toUpperCase(), true, "");
	const slashTag = await installDprint("fork/preview+1", true, "");
	for (const installed of [fork, upstream, caseTag, slashTag]) assert.strictEqual(installed.cacheHit, false);
	assert.strictEqual(new Set([fork.location, upstream.location, caseTag.location, slashTag.location]).size, 4);
	assert.deepStrictEqual(downloads, [
		`https://github.com/kjanat/dprint/releases/download/${tag}/dprint-${target.cacheKey}.zip`,
		`https://github.com/dprint/dprint/releases/download/${tag}/dprint-${target.cacheKey}.zip`,
		`https://github.com/kjanat/dprint/releases/download/${tag.toUpperCase()}/dprint-${target.cacheKey}.zip`,
		`https://github.com/kjanat/dprint/releases/download/fork%2Fpreview%2B1/dprint-${target.cacheKey}.zip`,
	]);
	for (
		const { repository, requested } of [
			{ repository: "kjanat/dprint", requested: tag },
			{ repository: "dprint/dprint", requested: tag },
			{ repository: "kjanat/dprint", requested: tag.toUpperCase() },
			{ repository: "kjanat/dprint", requested: "fork/preview+1" },
		]
	) {
		const cached = await installDprint(requested, true, "", parseRepository(repository));
		assert.strictEqual(cached.cacheHit, true);
		assert.strictEqual(await readFile(cached.location, "utf8"), "test binary");
	}
	assert.strictEqual(downloads.length, 4);
	assert.strictEqual(requests.length, 4);
	const uncached = await installDprint(tag, false, "");
	assert.strictEqual(uncached.cacheHit, false);
	assert.strictEqual(downloads.length, 5);
});
