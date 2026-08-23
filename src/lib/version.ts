import type { OutgoingHttpHeaders } from "node:http";

const USER_AGENT = "dprint-check-action";
const REPOSITORY = "dprint/dprint";

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

export function specifiedVersion(input: string): string | undefined {
	const requested = input.trim();
	return requested === "" || requested.toLowerCase() === "latest" ? undefined : requested;
}

function isRelease(value: unknown): value is Release {
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
}

export async function resolveRelease(
	input: string,
	token = "",
	http: JsonClient = jsonClient,
): Promise<Release> {
	const requested = specifiedVersion(input);
	const endpoint = requested === undefined
		? `https://api.github.com/repos/${REPOSITORY}/releases/latest`
		: `https://api.github.com/repos/${REPOSITORY}/releases/tags/${encodeURIComponent(requested)}`;
	const headers: OutgoingHttpHeaders = {
		accept: "application/vnd.github+json",
		"user-agent": USER_AGENT,
		"x-github-api-version": "2026-03-10",
	};
	if (token !== "") headers.authorization = `Bearer ${token}`;
	const response = await http.getJson<unknown>(endpoint, headers);
	if (response.statusCode === 404) {
		throw new Error(
			requested === undefined ? "The latest dprint release was not found" : `dprint release ${requested} was not found`,
		);
	}
	if (response.statusCode !== 200 || !isRelease(response.result)) {
		throw new Error(`Failed to resolve dprint release ${requested ?? "latest"} (HTTP ${response.statusCode})`);
	}
	return response.result;
}
