import { expect, test } from "bun:test";
import { specifiedVersion } from "../src/version.ts";

test("distinguishes explicit versions from latest release requests", () => {
	expect(specifiedVersion(" 0.56.1 ")).toBe("0.56.1");
	expect(specifiedVersion("latest")).toBeUndefined();
	expect(specifiedVersion(" LATEST ")).toBeUndefined();
	expect(specifiedVersion("")).toBeUndefined();
});
