import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTomlConfig } from "#lib/toml";

test("retains datetime text and fractional precision when converting TOML to JSON", () => {
	assert.deepStrictEqual(
		parseTomlConfig([
			"[plugin]",
			"time = 07:32:00",
			"precise = 07:32:00.123456789",
			"date = 1979-05-27",
			"local = 1979-05-27 07:32:00.123456",
			"offset = 1979-05-27T07:32:00.123456Z",
		].join("\n")),
		{
			plugin: {
				time: "07:32:00",
				precise: "07:32:00.123456789",
				date: "1979-05-27",
				local: "1979-05-27T07:32:00.123456",
				offset: "1979-05-27T07:32:00.123456Z",
			},
		},
	);
});

for (const value of ["40.0", "1e2", "nan", "inf", "2147483648", "-2147483649"]) {
	test(`rejects ${value} as the fork does, including inside arrays`, () => {
		assert.throws(() => parseTomlConfig(`[plugin]\nvalues = [${value}]`), /signed (?:integer|32-bit range)/);
	});
}

test("preserves integers, nested tables and arrays of tables", () => {
	assert.deepStrictEqual(
		parseTomlConfig([
			"min = -2147483648",
			"max = 2147483647",
			"[plugin]",
			"enabled = true",
			"[[plugin.commands]]",
			"command = 'format'",
		].join("\n")),
		{
			min: -2147483648,
			max: 2147483647,
			plugin: { enabled: true, commands: [{ command: "format" }] },
		},
	);
});
