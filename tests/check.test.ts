import { describe, expect, test } from "bun:test";
import { buildCheckArgs, parseArgs } from "../src/check.ts";

describe("buildCheckArgs", () => {
	test("uses auto-discovered config by default", () => {
		expect(buildCheckArgs("", "")).toEqual(["check"]);
	});

	test("passes a config path as one argument", () => {
		expect(buildCheckArgs("config files/dprint.json", "")).toEqual([
			"check",
			"--config",
			"config files/dprint.json",
		]);
	});

	test("parses quoted additional arguments without invoking a shell", () => {
		expect(buildCheckArgs("", "--allow-no-files 'source files/**/*.ts'")).toEqual([
			"check",
			"--allow-no-files",
			"source files/**/*.ts",
		]);
	});

	test("rejects an unterminated quote", () => {
		expect(() => parseArgs("--excludes \"source files")).toThrow("Unterminated quote");
	});
});
