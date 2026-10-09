interface SuggestionRange {
	path: string;
	startLine: number;
	endLine: number;
}

export interface ExistingSuggestion extends SuggestionRange {
	replacement: readonly string[];
}

interface ThreadVariables {
	owner: string;
	name: string;
	number: number;
	cursor: string | null;
}

type Query = (query: string, variables: ThreadVariables) => Promise<unknown>;

const THREAD_QUERY = `query DprintReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved isOutdated path line startLine diffSide startDiffSide
          comments(first: 1) {
            nodes { body author { login } pullRequestReview { body state } }
          }
        }
      }
    }
  }
}`;

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Preserve zero replacement lines (deletion) versus one empty replacement line. */
const replacementLines = (body: string): readonly string[] | undefined => {
	const lines = body.replaceAll("\r\n", "\n").split("\n");
	const match = /^(`{3,}|~{3,})suggestion[\t ]*$/u.exec(lines[0] ?? "");
	if (match === null || lines.at(-1) !== match[1]) return undefined;
	return lines.slice(1, -1);
};

const activeSuggestion = (value: unknown, viewer: string): ExistingSuggestion | undefined => {
	if (!record(value) || typeof value.isResolved !== "boolean" || typeof value.isOutdated !== "boolean") {
		throw new Error("Invalid PR review thread response");
	}
	if (value.isResolved || value.isOutdated || value.diffSide !== "RIGHT") return undefined;
	const { line, startLine, startDiffSide, path, comments } = value;
	if (line === null) return undefined;
	if (
		typeof path !== "string" || typeof line !== "number" || !Number.isSafeInteger(line) || line < 1
		|| !record(comments) || !Array.isArray(comments.nodes)
	) throw new Error("Invalid current PR review thread range");
	const start = startLine === null ? line : startLine;
	if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 1 || start > line) {
		throw new Error("Invalid current PR review thread start");
	}
	if (start !== line && startDiffSide !== "RIGHT") return undefined;
	const comment: unknown = comments.nodes[0];
	if (
		!record(comment) || typeof comment.body !== "string" || !record(comment.author)
		|| comment.author.login !== viewer || !record(comment.pullRequestReview)
	) return undefined;
	const review = comment.pullRequestReview;
	if (
		review.state !== "COMMENTED" || typeof review.body !== "string"
		|| !/<!-- dprint-review:[a-f\d]{40}:[a-f\d]{64} -->/u.test(review.body)
	) return undefined;
	const replacement = replacementLines(comment.body);
	return replacement === undefined ? undefined : { path, startLine: start, endLine: line, replacement };
};

export const suggestionKey = (suggestion: ExistingSuggestion): string =>
	JSON.stringify([
		suggestion.path,
		suggestion.startLine,
		suggestion.endLine,
		suggestion.replacement.map(line => line.replace(/\r$/u, "")),
	]);

/** Inspect every live thread, including suggestions attached to earlier PR commits. */
export const readExistingSuggestions = async (
	repository: string,
	number: number,
	query: Query,
): Promise<ExistingSuggestion[]> => {
	const [owner, name] = repository.split("/");
	if (owner === undefined || name === undefined) throw new Error("Invalid review repository");
	const suggestions: ExistingSuggestion[] = [];
	let cursor: string | null = null;
	const cursors = new Set<string>();
	for (;;) {
		const response = await query(THREAD_QUERY, { owner, name, number, cursor });
		if (
			!record(response) || ("errors" in response && (!Array.isArray(response.errors) || response.errors.length !== 0))
			|| !record(response.data)
		) throw new Error("Unable to read PR review threads");
		const { viewer, repository: repo } = response.data;
		if (
			!record(viewer) || typeof viewer.login !== "string" || !record(repo) || !record(repo.pullRequest)
			|| !record(repo.pullRequest.reviewThreads)
		) throw new Error("Invalid PR review thread data");
		const { nodes, pageInfo } = repo.pullRequest.reviewThreads;
		if (!Array.isArray(nodes) || !record(pageInfo) || typeof pageInfo.hasNextPage !== "boolean") {
			throw new Error("Invalid PR review thread page");
		}
		for (const node of nodes) {
			const suggestion = activeSuggestion(node, viewer.login);
			if (suggestion !== undefined) suggestions.push(suggestion);
		}
		if (!pageInfo.hasNextPage) return suggestions;
		const next: unknown = pageInfo.endCursor;
		if (typeof next !== "string" || next === "" || cursors.has(next)) {
			throw new Error("Invalid PR review thread cursor");
		}
		cursors.add(next);
		cursor = next;
	}
};
