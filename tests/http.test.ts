import { expect, mock, test } from "bun:test";

import { requestWithRetry } from "#lib/http";

test("retries network failures with observable backoff", async () => {
	const fetch = mock()
		.mockRejectedValueOnce(new Error("connection reset"))
		.mockResolvedValueOnce(new Response("ok"));
	const sleep = mock(async () => {});
	const onRetry = mock(() => {});

	const response = await requestWithRetry("https://example.com", undefined, { fetch, sleep, onRetry });

	expect(await response.text()).toBe("ok");
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(sleep).toHaveBeenCalledWith(1000);
	expect(onRetry).toHaveBeenCalledWith(1, 3);
});
