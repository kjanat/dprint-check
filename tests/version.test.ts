import { describe, expect, test } from "bun:test";
import type { OutgoingHttpHeaders } from "node:http";

import { resolveRelease, specifiedVersion } from "#lib/version";

const release = {
	tag_name: "0.56.1",
	assets: [{
		name: "dprint.zip",
		browser_download_url: "https://example.com/dprint.zip",
		digest: null,
	}],
};

function successfulClient() {
	const requests: Array<{ url: string; headers?: OutgoingHttpHeaders }> = [];
	const getJson = async <T>(url: string, headers?: OutgoingHttpHeaders): Promise<{
		statusCode: number;
		result: T | null;
	}> => {
		requests.push({ url, headers });
		return { statusCode: 200, result: release as T };
	};
	return { client: { getJson }, requests };
}

test.each([
	{ label: "explicit version", input: " 0.56.1 ", expected: "0.56.1" },
	{ label: "latest", input: "latest", expected: undefined },
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

		expect(await resolveRelease("0.56.1", "test-token", client)).toEqual(release);
		expect(requests).toEqual([{
			url: "https://api.github.com/repos/dprint/dprint/releases/tags/0.56.1",
			headers: {
				accept: "application/vnd.github+json",
				"x-github-api-version": "2026-03-10",
				authorization: "Bearer test-token",
			},
		}]);
	});

	test("requests the latest release without an authorization header", async () => {
		const { client, requests } = successfulClient();

		expect(await resolveRelease("latest", "", client)).toEqual(release);
		expect(requests).toEqual([{
			url: "https://api.github.com/repos/dprint/dprint/releases/latest",
			headers: {
				accept: "application/vnd.github+json",
				"x-github-api-version": "2026-03-10",
			},
		}]);
	});

	test("rejects malformed release metadata", () => {
		const http = {
			getJson: async <T>() => ({ statusCode: 200, result: { tag_name: "0.56.1", assets: [{}] } as T }),
		};
		expect(resolveRelease("latest", "", http)).rejects.toThrow(
			"Failed to resolve dprint release latest (HTTP 200)",
		);
	});
});
