import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

export const createTemporaryDirectory = async (root: string, prefix: string): Promise<string> => {
	await mkdir(root, { recursive: true });
	return mkdtemp(join(root, prefix));
};
