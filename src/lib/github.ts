import type { OutgoingHttpHeaders } from "node:http";

export const GITHUB_API = {
	baseUrl: "https://api.github.com",
	jsonMediaType: "application/vnd.github+json",
	userAgent: "dprint-check-action",
	version: "2026-03-10",
	webUrl: "https://github.com",
} as const;

export const githubApiHeaders = (token = ""): OutgoingHttpHeaders => ({
	accept: GITHUB_API.jsonMediaType,
	"user-agent": GITHUB_API.userAgent,
	"x-github-api-version": GITHUB_API.version,
	...(token === "" ? {} : { authorization: `Bearer ${token}` }),
});
