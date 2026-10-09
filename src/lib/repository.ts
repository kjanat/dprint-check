import { homedir } from "node:os";
import { join } from "node:path";

export const PLUGIN_CACHE_ENVIRONMENT = {
	root: "DPRINT_ACTION_CACHE_ROOT",
	path: "DPRINT_ACTION_CACHE_PATH",
} as const;

/** GitHub release source and its unambiguous filesystem/cache namespace. */
export interface ReleaseRepository {
	readonly name: string;
	readonly cacheKey: string;
}

export function parseRepository(input = "kjanat/dprint"): ReleaseRepository {
	const name = input.trim().toLowerCase() || "kjanat/dprint";
	if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[a-z\d][a-z\d._-]*$/u.test(name)) {
		throw new Error(`Invalid repository: ${input}. Expected owner/repo.`);
	}
	return { name, cacheKey: name.replace("/", "_") };
}

/** Keep the user's cache root while avoiding nesting across action invocations. */
export function resolvePluginCacheDirectory(
	repository: ReleaseRepository,
	environment: Readonly<Record<string, string | undefined>>,
): { root: string; directory: string } {
	const configured = environment["DPRINT_CACHE_DIR"];
	const inheritedRoot = configured !== undefined && configured === environment[PLUGIN_CACHE_ENVIRONMENT.path]
		? environment[PLUGIN_CACHE_ENVIRONMENT.root]
		: undefined;
	const root = inheritedRoot ?? configured ?? join(homedir(), ".cache", "dprint");
	return { root, directory: join(root, repository.cacheKey) };
}
