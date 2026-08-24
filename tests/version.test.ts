import { describe, expect, test } from "bun:test";
import type { OutgoingHttpHeaders } from "node:http";

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

test.each([
	{ label: "explicit version", input: ` ${TEST_DPRINT_VERSION} `, expected: TEST_DPRINT_VERSION },
	{ label: "latest", input: DPRINT.latestVersion, expected: undefined },
	{ label: "case-insensitive latest", input: " LATEST ", expected: undefined },
	{ label: "empty input", input: "", expected: undefined },
])("normalizes $label", ({ input, expected }) => {
	expect(specifiedVersion(input)).toBe(expected);
});

describe("resolveRelease", () => {
	test("reports a missing requested release explicitly", () => {
		const http = {
			getJson: async <T>() => ({ statusCode: 404, result: null as T | null }),
		};
		expect(resolveRelease("99.0.0", "", http)).rejects.toThrow("dprint release 99.0.0 was not found");
	});

	test("authenticates release metadata requests", async () => {
		const { client, requests } = successfulClient();

		expect(await resolveRelease(TEST_DPRINT_VERSION, "test-token", client)).toEqual(release);
		expect(requests).toEqual([{
			url: `${GITHUB_API.dprintReleasesUrl}/tags/${TEST_DPRINT_VERSION}`,
			headers: githubApiHeaders("test-token"),
		}]);
	});

	test("requests the latest release without an authorization header", async () => {
		const { client, requests } = successfulClient();

		expect(await resolveRelease(DPRINT.latestVersion, "", client)).toEqual(release);
		expect(requests).toEqual([{
			url: `${GITHUB_API.dprintReleasesUrl}/${DPRINT.latestVersion}`,
			headers: githubApiHeaders(),
		}]);
	});

	test("rejects malformed release metadata", () => {
		const http = {
			getJson: async <T>() => ({ statusCode: 200, result: { tag_name: TEST_DPRINT_VERSION, assets: [{}] } as T }),
		};
		expect(resolveRelease(DPRINT.latestVersion, "", http)).rejects.toThrow(
			"Failed to resolve dprint release latest (HTTP 200)",
		);
	});
});
