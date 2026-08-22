import { HttpClient } from "@actions/http-client";

export interface ReleaseAsset {
	name: string;
	browser_download_url: string;
	digest: string | null;
}

export interface Release {
	tag_name: string;
	assets: ReleaseAsset[];
}

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

export async function resolveRelease(input: string): Promise<Release> {
	const requested = specifiedVersion(input);
	const endpoint = requested === undefined
		? "https://api.github.com/repos/dprint/dprint/releases/latest"
		: `https://api.github.com/repos/dprint/dprint/releases/tags/${encodeURIComponent(requested)}`;
	const response = await new HttpClient("dprint-check-action").getJson<unknown>(endpoint);
	if (response.statusCode !== 200 || !isRelease(response.result)) {
		throw new Error(`Failed to resolve dprint release ${requested ?? "latest"} (HTTP ${response.statusCode})`);
	}
	return response.result;
}
