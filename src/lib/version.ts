import type { OutgoingHttpHeaders } from "node:http";

import { DPRINT } from "#lib/contracts";
import { GITHUB_API, githubApiHeaders } from "#lib/github";

export interface ReleaseAsset {
	name: string;
	browser_download_url: string;
	digest: string | null;
}

export interface Release {
	tag_name: string;
	assets: ReleaseAsset[];
}

interface JsonClient {
	getJson<T>(url: string, headers?: OutgoingHttpHeaders): Promise<{ statusCode: number; result: T | null }>;
}

const jsonClient: JsonClient = {
	async getJson<T>(url: string, headers: OutgoingHttpHeaders = {}) {
		const requestHeaders = new Headers();
		for (const [name, value] of Object.entries(headers)) {
			if (value !== undefined) requestHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value));
		}
		const response = await fetch(url, { headers: requestHeaders });
		return { statusCode: response.status, result: await response.json() as T };
	},
};

export const specifiedVersion = (input: string): string | undefined => {
	const requested = input.trim();
	return requested === "" || requested.toLowerCase() === DPRINT.latestVersion ? undefined : requested;
};

const isRelease = (value: unknown): value is Release => {
	if (value === null || typeof value !== "object") return false;
	const release = value as Partial<Release>;
	return typeof release.tag_name === "string" && release.tag_name !== ""
		&& Array.isArray(release.assets)
		&& release.assets.every(asset =>
			asset !== null
			&& typeof asset === "object"
			&& typeof (asset as Partial<ReleaseAsset>).name === "string"
			&& typeof (asset as Partial<ReleaseAsset>).browser_download_url === "string"
			&& ((asset as Partial<ReleaseAsset>).digest === null
				|| typeof (asset as Partial<ReleaseAsset>).digest === "string")
		);
};

export const resolveRelease = async (
	input: string,
	token = "",
	http: JsonClient = jsonClient,
): Promise<Release> => {
	const requested = specifiedVersion(input);
	const endpoint = requested === undefined
		? `${GITHUB_API.dprintReleasesUrl}/${DPRINT.latestVersion}`
		: `${GITHUB_API.dprintReleasesUrl}/tags/${encodeURIComponent(requested)}`;
	const response = await http.getJson<unknown>(endpoint, githubApiHeaders(token));
	if (response.statusCode === 404) {
		throw new Error(
			requested === undefined ? "The latest dprint release was not found" : `dprint release ${requested} was not found`,
		);
	}
	if (response.statusCode !== 200 || !isRelease(response.result)) {
		throw new Error(
			`Failed to resolve dprint release ${requested ?? DPRINT.latestVersion} (HTTP ${response.statusCode})`,
		);
	}
	return response.result;
};
