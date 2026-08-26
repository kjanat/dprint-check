import assert from "node:assert/strict";
import type { OutgoingHttpHeaders } from "node:http";
import { describe, test } from "node:test";

import { DPRINT } from "#lib/contracts";
import { GITHUB_API, githubApiHeaders } from "#lib/github";
import { resolveRelease, specifiedVersion } from "#lib/version";
import { releaseAsset, TEST_DPRINT_ASSET, TEST_DPRINT_VERSION } from "#test/helpers";

const release = {
	tag_name: TEST_DPRINT_VERSION,
	assets: [releaseAsset(TEST_DPRINT_ASSET)],
};

const successfulClient = () => {
	const requests: Array<{ url: string; headers?: OutgoingHttpHeaders }> = [];
	const getJson = async <T>(url: string, headers?: OutgoingHttpHeaders): Promise<{
		statusCode: number;
		result: T | null;
	}> => {
		requests.push({ url, headers });
		return { statusCode: 200, result: release as T };
	};
	return { client: { getJson }, requests };
};

const normalizationCases = [
	{ label: "explicit version", input: ` ${TEST_DPRINT_VERSION} `, expected: TEST_DPRINT_VERSION },
	{ label: "latest", input: DPRINT.latestVersion, expected: undefined },
	{ label: "case-insensitive latest", input: " LATEST ", expected: undefined },
	{ label: "empty input", input: "", expected: undefined },
];

for (const { label, input, expected } of normalizationCases) {
	test(`normalizes ${label}`, () => {
		assert.strictEqual(specifiedVersion(input), expected);
	});
}

describe("resolveRelease", () => {
	test("reports a missing requested release explicitly", async () => {
		const http = {
			getJson: async () => ({ statusCode: 404, result: null }),
		};
		await assert.rejects(resolveRelease("99.0.0", "", http), {
			message: "dprint release 99.0.0 was not found",
		});
	});

	test("authenticates release metadata requests", async () => {
		const { client, requests } = successfulClient();

		assert.deepStrictEqual(await resolveRelease(TEST_DPRINT_VERSION, "test-token", client), release);
		assert.deepStrictEqual(requests, [{
			url: `${GITHUB_API.dprintReleasesUrl}/tags/${TEST_DPRINT_VERSION}`,
			headers: githubApiHeaders("test-token"),
		}]);
	});

	test("requests the latest release without an authorization header", async () => {
		const { client, requests } = successfulClient();

		assert.deepStrictEqual(await resolveRelease(DPRINT.latestVersion, "", client), release);
		assert.deepStrictEqual(requests, [{
			url: `${GITHUB_API.dprintReleasesUrl}/${DPRINT.latestVersion}`,
			headers: githubApiHeaders(),
		}]);
	});

	test("rejects malformed release metadata", async () => {
		const http = {
			getJson: async <T>() => ({ statusCode: 200, result: { tag_name: TEST_DPRINT_VERSION, assets: [{}] } as T }),
		};
		await assert.rejects(resolveRelease(DPRINT.latestVersion, "", http), {
			message: "Failed to resolve dprint release latest (HTTP 200)",
		});
	});
});
