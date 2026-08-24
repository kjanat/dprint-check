import { join } from "node:path";

import { addMatcher, info } from "#lib/actions";

export const PROBLEM_MATCHER_FILE = "problem-matcher.json";

export const registerProblemMatcher = (bundleDirectory: string = import.meta.dirname): string => {
	const path = join(bundleDirectory, "..", PROBLEM_MATCHER_FILE);
	addMatcher(path);
	info("Registered the dprint problem matcher for later steps");
	return path;
};
