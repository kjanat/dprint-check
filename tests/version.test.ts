import { describe, expect, test } from "bun:test";
import type { OutgoingHttpHeaders } from "node:http";

import { resolveRelease, specifiedVersion } from "#lib/version";

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
		let requestedUrl = "";
		let authorization: string | string[] | undefined;
		const http = {
			getJson: async <T>(url: string, headers?: OutgoingHttpHeaders) => {
				requestedUrl = url;
				authorization = headers?.["authorization"];
				return {
					statusCode: 200,
					result: {
						tag_name: "0.56.1",
						assets: [{
							name: "dprint.zip",
							browser_download_url: "https://example.com/dprint.zip",
							digest: null,
						}],
					} as T,
				};
			},
		};

		expect((await resolveRelease("0.56.1", "test-token", http)).tag_name).toBe("0.56.1");
		expect(requestedUrl).toEndWith("/releases/tags/0.56.1");
		expect(authorization).toBe("Bearer test-token");
	});
});
