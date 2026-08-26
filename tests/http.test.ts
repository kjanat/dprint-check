import assert from "node:assert/strict";
import { test } from "node:test";

import { requestWithRetry } from "#lib/http";

test("retries network failures with observable backoff", async t => {
	let attempts = 0;
	const fetch = t.mock.fn(async () => {
		attempts++;
		if (attempts === 1) throw new Error("connection reset");
		return new Response("ok");
	});
	const sleep = t.mock.fn(async () => {});
	const onRetry = t.mock.fn(() => {});

	const response = await requestWithRetry("https://example.com", undefined, { fetch, sleep, onRetry });

	assert.strictEqual(await response.text(), "ok");
	assert.strictEqual(fetch.mock.callCount(), 2);
	assert.deepStrictEqual(sleep.mock.calls[0]?.arguments, [1000]);
	assert.deepStrictEqual(onRetry.mock.calls[0]?.arguments, [1, 3]);
});
