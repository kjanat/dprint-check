import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { postFormattingReview, type ReviewOptions } from "#lib/review";

const sha = "a".repeat(40);
const workspace = resolve("review-workspace");
const environment = {
	GITHUB_EVENT_NAME: "pull_request",
	GITHUB_EVENT_PATH: "event.json",
	GITHUB_REPOSITORY: "owner/project",
	GITHUB_WORKSPACE: workspace,
};
const diff = {
	file: "README.md",
	diff:
		"--- original\n+++ formatted\n@@ -13,8 +13,11 @@\n jobs:\n   style:\n     runs-on: ubuntu-latest\n-    permissions: { \n-    contents: read, checks: write, code-quality: write }\n+    permissions: {\n+      contents: read,\n+      checks: write,\n+      code-quality: write,\n+    }\n     steps: [uses: actions/checkout@v7, uses: kjanat/dprint-check@v3]\n ```\n \n",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isReviewPost = (request: { url: string; init: RequestInit | undefined }): boolean =>
	request.init?.method === "POST" && request.url.endsWith("/reviews");
const thread = (
	comment: Record<string, unknown>,
	reviewBody = `<!-- dprint-review:${"b".repeat(40)}:${"c".repeat(64)} -->`,
) => ({
	isResolved: false,
	isOutdated: false,
	path: comment.path,
	line: comment.line,
	startLine: comment.start_line ?? null,
	diffSide: comment.side ?? "RIGHT",
	startDiffSide: comment.start_side ?? null,
	comments: {
		nodes: [{
			body: comment.body,
			author: { login: "action-bot" },
			pullRequestReview: { body: reviewBody, state: "COMMENTED" },
		}],
	},
});

const threadResponse = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
	data: {
		viewer: { login: "action-bot" },
		repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } } } },
	},
});

const setup = (overrides: Partial<ReviewOptions> = {}) => {
	const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
	const messages: string[] = [];
	const warnings: string[] = [];
	const threads: unknown[] = [];
	const options: ReviewOptions = {
		token: "test-credential",
		environment,
		readEvent: async () =>
			JSON.stringify({ pull_request: { number: 7, head: { sha }, base: { repo: { full_name: "owner/project" } } } }),
		checkoutSha: async () => sha,
		cleanFile: async () => true,
		onInfo: message => messages.push(message),
		onWarning: message => warnings.push(message),
		fetch: async (input, init) => {
			const url = String(input);
			requests.push({ url, init });
			if (url.endsWith("/graphql")) return Response.json(threadResponse(threads));
			if (init?.method === "POST" && String(input).endsWith("/reviews")) {
				const review: unknown = JSON.parse(String(init.body));
				if (isRecord(review) && typeof review.body === "string" && Array.isArray(review.comments)) {
					for (const comment of review.comments) if (isRecord(comment)) threads.push(thread(comment, review.body));
				}
				return Response.json({ id: 1 });
			}
			if (url.includes("/files?")) {
				return Response.json([{ filename: "README.md", patch: "@@ -10,20 +10,20 @@\n context" }]);
			}
			if (url.includes("/reviews?")) return Response.json([]);
			return Response.json({ head: { sha } });
		},
		...overrides,
	};
	return { options, requests, messages, warnings, threads };
};

test("posts a single COMMENT review with precise multiline replacement and deduplicated results", async () => {
	const { options, requests, warnings } = setup();
	await postFormattingReview([diff, diff], options);
	const posts = requests.filter(isReviewPost);
	assert.equal(posts.length, 1);
	assert.equal(posts[0]?.url, "https://api.github.com/repos/owner/project/pulls/7/reviews");
	const body: unknown = JSON.parse(String(posts[0]?.init?.body));
	assert.ok(typeof body === "object" && body !== null && "comments" in body && "event" in body && "commit_id" in body);
	assert.equal(body.event, "COMMENT");
	assert.equal(body.commit_id, sha);
	assert.deepEqual(body.comments, [{
		path: "README.md",
		line: 17,
		side: "RIGHT",
		start_line: 16,
		start_side: "RIGHT",
		body:
			"```suggestion\n    permissions: {\n      contents: read,\n      checks: write,\n      code-quality: write,\n    }\n```",
	}]);
	assert.deepEqual(warnings, []);
});

test("leaves changes outside the PR diff in the review summary", async () => {
	const state = setup();
	const originalFetch = state.options.fetch;
	state.options.fetch = async (input, init) =>
		String(input).includes("/files?")
			? Response.json([{ filename: "README.md", patch: "@@ -1 +1 @@\n-old\n+new" }])
			: (originalFetch ?? globalThis.fetch)(input, init);
	await postFormattingReview([diff], state.options);
	const body = String(state.requests.find(isReviewPost)?.init?.body);
	assert.match(body, /outside commentable PR ranges/u);
	assert.match(body, /"comments":\[\]/u);
});

test("does not repost identical results on a rerun", async () => {
	const state = setup();
	await postFormattingReview([diff], state.options);
	const previousBody: unknown = JSON.parse(
		String(state.requests.find(isReviewPost)?.init?.body),
	);
	assert.ok(typeof previousBody === "object" && previousBody !== null && "body" in previousBody);
	const originalFetch = state.options.fetch;
	state.options.fetch = async (input, init) =>
		String(input).includes("/reviews?")
			? Response.json([previousBody])
			: (originalFetch ?? globalThis.fetch)(input, init);
	await postFormattingReview([diff], state.options);
	assert.equal(state.requests.filter(isReviewPost).length, 1);
	assert.match(state.messages.at(-1) ?? "", /already exists/u);
});

test("skips review on non-PR events and clean results", async () => {
	const state = setup({ environment: { ...environment, GITHUB_EVENT_NAME: "push" } });
	await postFormattingReview([diff], state.options);
	await postFormattingReview([], setup().options);
	assert.equal(state.requests.length, 0);
});

test("refuses suggestions generated against a merge commit rather than the PR head", async () => {
	const state = setup({ checkoutSha: async () => "b".repeat(40) });
	await postFormattingReview([diff], state.options);
	assert.equal(state.requests.length, 0);
	assert.match(state.warnings[0] ?? "", /PR head commit/u);
});

test("rejects stale PR events and changed heads before posting", async () => {
	for (const changeAfterFiles of [false, true]) {
		const state = setup();
		const originalFetch = state.options.fetch;
		let heads = 0;
		state.options.fetch = async (input, init) => {
			if (String(input).endsWith("/pulls/7")) {
				heads++;
				return Response.json({ head: { sha: changeAfterFiles && heads === 1 ? sha : "b".repeat(40) } });
			}
			return (originalFetch ?? globalThis.fetch)(input, init);
		};
		await postFormattingReview([diff], state.options);
		assert.equal(state.requests.filter(isReviewPost).length, 0);
		assert.match(state.warnings[0] ?? "", /PR head changed/u);
	}
});

test("permission failures warn without throwing or changing formatting results", async () => {
	const state = setup({ fetch: async () => new Response(null, { status: 403 }) });
	await postFormattingReview([diff], state.options);
	assert.match(state.warnings[0] ?? "", /HTTP 403/u);
});

test("does not publish modified checkout content as a suggestion for unchanged PR head", async () => {
	const state = setup({ cleanFile: async () => false });
	await postFormattingReview([diff], state.options);
	const body = String(state.requests.find(isReviewPost)?.init?.body);
	assert.match(body, /modified checkout files/u);
	assert.match(body, /"comments":\[\]/u);
});

test("review fingerprint remains stable across changed NDJSON order and duplicate roots", async () => {
	const other = { ...diff, file: "other.md" };
	const state = setup();
	await postFormattingReview([diff, other], state.options);
	const previousBody: unknown = JSON.parse(
		String(state.requests.find(isReviewPost)?.init?.body),
	);
	const originalFetch = state.options.fetch;
	state.options.fetch = async (input, init) =>
		String(input).includes("/reviews?")
			? Response.json([previousBody])
			: (originalFetch ?? globalThis.fetch)(input, init);
	await postFormattingReview([other, diff, diff], state.options);
	assert.equal(state.requests.filter(isReviewPost).length, 1);
});

test("identical reviews remain deduplicated across Windows and Linux checkout paths", async () => {
	const state = setup({ environment: { ...environment, GITHUB_WORKSPACE: "C:\\runner\\project" } });
	await postFormattingReview([{ ...diff, file: "C:\\runner\\project\\README.md" }], state.options);
	const previousBody: unknown = JSON.parse(
		String(state.requests.find(isReviewPost)?.init?.body),
	);
	const originalFetch = state.options.fetch;
	state.options.environment = { ...environment, GITHUB_WORKSPACE: "/home/runner/project" };
	state.options.fetch = async (input, init) =>
		String(input).includes("/reviews?")
			? Response.json([previousBody])
			: (originalFetch ?? globalThis.fetch)(input, init);
	await postFormattingReview([{ ...diff, file: "/home/runner/project/README.md" }], state.options);
	assert.equal(state.requests.filter(isReviewPost).length, 1);
});

test("never retries an ambiguous POST response", async () => {
	const state = setup();
	const originalFetch = state.options.fetch;
	let attempts = 0;
	state.options.fetch = async (input, init) => {
		if (init?.method === "POST" && String(input).endsWith("/reviews")) {
			attempts++;
			throw new Error("connection closed after submission");
		}
		return (originalFetch ?? globalThis.fetch)(input, init);
	};
	await postFormattingReview([diff], state.options);
	assert.equal(attempts, 1);
	assert.match(state.warnings[0] ?? "", /connection closed/u);
});

test("paginates PR files and reviews and honors the configured API server", async () => {
	const state = setup({ environment: { ...environment, GITHUB_API_URL: "https://github.example/api/v3" } });
	const originalFetch = state.options.fetch;
	const urls: string[] = [];
	state.options.fetch = async (input, init) => {
		const url = String(input);
		urls.push(url);
		if (url.includes("/files?") && url.endsWith("page=1")) {
			return Response.json(Array.from({ length: 100 }, (_, index) => ({ filename: `${index}.txt` })));
		}
		if (url.includes("/reviews?") && url.endsWith("page=1")) {
			return Response.json(Array.from({ length: 100 }, () => ({ body: "Other review" })));
		}
		if (url.includes("/files?") && url.endsWith("page=2")) {
			return Response.json([{ filename: "README.md", patch: "@@ -1 +1 @@\n-old\n+new" }]);
		}
		return (originalFetch ?? globalThis.fetch)(input, init);
	};
	await postFormattingReview([diff], state.options);
	assert.ok(
		urls.every(url => url.startsWith("https://github.example/api/v3/") || url === "https://github.example/api/graphql"),
	);
	assert.ok(urls.some(url => url.includes("/files?") && url.endsWith("page=2")));
	assert.ok(urls.some(url => url.includes("/reviews?") && url.endsWith("page=2")));
	assert.deepEqual(state.warnings, []);
});

const existingComment = {
	path: "README.md",
	line: 17,
	start_line: 16,
	side: "RIGHT",
	start_side: "RIGHT",
	body:
		"```suggestion\n    permissions: {\n      contents: read,\n      checks: write,\n      code-quality: write,\n    }\n```",
};

test("existing current suggestions from earlier commits suppress duplicate review and return exact coverage", async () => {
	const state = setup();
	state.threads.push(thread(existingComment));
	const covered = await postFormattingReview([diff], state.options);
	assert.equal(state.requests.filter(isReviewPost).length, 0);
	assert.deepEqual(covered.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })), [{
		path: "README.md",
		startLine: 16,
		endLine: 17,
	}]);
	assert.match(state.messages.at(-1) ?? "", /every suggestion/u);
});

test("changed PR head during thread lookup retains annotations even when every range is covered", async () => {
	const state = setup();
	state.threads.push(thread(existingComment));
	const originalFetch = state.options.fetch;
	let threadsRead = false;
	state.options.fetch = async (input, init) => {
		const url = String(input);
		if (url.endsWith("/pulls/7") && threadsRead) {
			return Response.json({ head: { sha: "b".repeat(40) } });
		}
		const response = await (originalFetch ?? globalThis.fetch)(input, init);
		if (url.endsWith("/graphql")) threadsRead = true;
		return response;
	};
	assert.deepEqual(await postFormattingReview([diff], state.options), []);
	assert.equal(state.requests.filter(isReviewPost).length, 0);
	assert.match(state.warnings[0] ?? "", /PR head changed/u);
});

test("changed complete results post only the new range in one review", async () => {
	const state = setup();
	state.threads.push(thread(existingComment));
	const partial = { ...diff, diff: `${diff.diff}@@ -24 +27 @@\n-const z=1;\n+const z = 1;\n` };
	const covered = await postFormattingReview([partial], state.options);
	const posts = state.requests.filter(isReviewPost);
	assert.equal(posts.length, 1);
	const body: unknown = JSON.parse(String(posts[0]?.init?.body));
	assert.ok(isRecord(body));
	assert.deepEqual(body.comments, [{
		path: "README.md",
		line: 24,
		side: "RIGHT",
		body: "```suggestion\nconst z = 1;\n```",
	}]);
	assert.equal(covered.length, 1);
});

test("same range with changed replacement remains eligible", async () => {
	const state = setup();
	state.threads.push(thread({ ...existingComment, body: "```suggestion\nDifferent replacement\n```" }));
	assert.deepEqual(await postFormattingReview([diff], state.options), []);
	assert.equal(state.requests.filter(isReviewPost).length, 1);
});

test("matches current remapped thread lines rather than historical coordinates", async () => {
	const state = setup();
	state.threads.push({
		...thread({ ...existingComment, line: 20, start_line: 19 }),
		originalLine: 17,
		originalStartLine: 16,
	});
	const shifted = { ...diff, diff: diff.diff.replace("-13,8 +13,11", "-16,8 +16,11") };
	const covered = await postFormattingReview([shifted], state.options);
	assert.equal(covered[0]?.startLine, 19);
	assert.equal(state.requests.filter(isReviewPost).length, 0);
});

test("resolved, outdated, left-side, unrelated and unsubmitted reviews do not suppress current suggestions", async () => {
	const original = thread(existingComment);
	for (
		const previous of [
			{ ...original, isResolved: true },
			{ ...original, isOutdated: true },
			{ ...original, diffSide: "LEFT" },
			thread(existingComment, "An unrelated manual review"),
			{
				...original,
				comments: {
					nodes: original.comments.nodes.map(comment => ({ ...comment, author: { login: "someone-else" } })),
				},
			},
			{
				...original,
				comments: {
					nodes: original.comments.nodes.map(comment => ({
						...comment,
						pullRequestReview: { ...comment.pullRequestReview, state: "PENDING" },
					})),
				},
			},
			{
				...original,
				comments: {
					nodes: original.comments.nodes.map(comment => ({
						...comment,
						pullRequestReview: { ...comment.pullRequestReview, state: "DISMISSED" },
					})),
				},
			},
		]
	) {
		const state = setup();
		state.threads.push(previous);
		await postFormattingReview([diff], state.options);
		assert.equal(state.requests.filter(isReviewPost).length, 1);
	}
});

test("resolved or deleted suggestion is recreated even when the old complete-result marker matches", async () => {
	for (const resolved of [true, false]) {
		const state = setup();
		await postFormattingReview([diff], state.options);
		const priorReview: unknown = JSON.parse(String(state.requests.find(isReviewPost)?.init?.body));
		const originalFetch = state.options.fetch;
		state.options.fetch = async (input, init) =>
			String(input).includes("/reviews?")
				? Response.json([priorReview])
				: (originalFetch ?? globalThis.fetch)(input, init);
		if (resolved) state.threads.splice(0, state.threads.length, { ...thread(existingComment), isResolved: true });
		else state.threads.length = 0;
		await postFormattingReview([diff], state.options);
		assert.equal(state.requests.filter(isReviewPost).length, 2);
	}
});

test("existing deletion remains distinct from replacement by a blank line", async () => {
	for (const blank of [true, false]) {
		const state = setup();
		state.threads.push(
			thread({ path: "README.md", line: 16, body: blank ? "```suggestion\n```" : "```suggestion\n\n```" }),
		);
		const change = {
			file: "README.md",
			diff: blank
				? "--- original\n+++ formatted\n@@ -16 +16 @@\n-old\n+\n"
				: "--- original\n+++ formatted\n@@ -16 +16,0 @@\n-old\n",
		};
		await postFormattingReview([change], state.options);
		assert.equal(state.requests.filter(isReviewPost).length, 1);
	}
});

test("current single-line thread and equivalent backtick fence suppress duplicate suggestion", async () => {
	const state = setup();
	state.threads.push(thread({ path: "README.md", line: 16, body: "````suggestion\nnew\n````" }));
	const covered = await postFormattingReview([{
		file: "README.md",
		diff: "--- original\n+++ formatted\n@@ -16 +16 @@\n-old\n+new\n",
	}], state.options);
	assert.equal(covered.length, 1);
	assert.equal(state.requests.filter(isReviewPost).length, 0);
});

test("same replacement in another file or overlapping range does not suppress a suggestion", async () => {
	for (
		const comment of [
			{ ...existingComment, path: "other.md" },
			{ ...existingComment, start_line: 15 },
			{ ...existingComment, line: 18 },
		]
	) {
		const state = setup();
		state.threads.push(thread(comment));
		await postFormattingReview([diff], state.options);
		assert.equal(state.requests.filter(isReviewPost).length, 1);
	}
});

test("paginates all review threads on long PRs and uses explicit GraphQL endpoint", async () => {
	const state = setup({ environment: { ...environment, GITHUB_GRAPHQL_URL: "https://graphql.example/query" } });
	const originalFetch = state.options.fetch;
	const cursors: unknown[] = [];
	state.options.fetch = async (input, init) => {
		if (String(input) === "https://graphql.example/query") {
			const body: unknown = JSON.parse(String(init?.body));
			assert.ok(isRecord(body) && isRecord(body.variables));
			cursors.push(body.variables.cursor);
			return Response.json(
				body.variables.cursor === null
					? threadResponse(
						Array.from({ length: 100 }, () => ({ ...thread(existingComment), isResolved: true })),
						true,
						"next-page",
					)
					: threadResponse([thread(existingComment)]),
			);
		}
		return (originalFetch ?? globalThis.fetch)(input, init);
	};
	const covered = await postFormattingReview([diff], state.options);
	assert.deepEqual(cursors, [null, "next-page"]);
	assert.equal(covered.length, 1);
	assert.equal(state.requests.filter(isReviewPost).length, 0);
});

test("thread API partial errors or broken pagination prevent unsafe duplicate posting", async () => {
	for (
		const response of [
			{ ...threadResponse([]), errors: [{ message: "Rate limit" }] },
			threadResponse([], true, null),
			threadResponse([], true, "repeated"),
			{ data: { viewer: { login: "action-bot" }, repository: null } },
		]
	) {
		const state = setup();
		const originalFetch = state.options.fetch;
		state.options.fetch = async (input, init) =>
			String(input).endsWith("/graphql")
				? Response.json(response)
				: (originalFetch ?? globalThis.fetch)(input, init);
		assert.deepEqual(await postFormattingReview([diff], state.options), []);
		assert.equal(state.requests.filter(isReviewPost).length, 0);
		assert.equal(state.warnings.length, 1);
	}
});
