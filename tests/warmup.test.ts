import { warmupPlugins } from "#lib/warmup";
import { expect, mock, test } from "bun:test";

test("warms every discovered config sequentially", async () => {
	const configs = ["/workspace/dprint.json", "/workspace/packages/example/dprint.jsonc"];
	let active = 0;
	let maximumActive = 0;
	const execute = mock(async () => {
		active++;
		maximumActive = Math.max(maximumActive, active);
		await Promise.resolve();
		active--;
	});

	expect(await warmupPlugins("/tools/dprint", configs, execute)).toBeTrue();
	expect(maximumActive).toBe(1);
	expect(execute).toHaveBeenNthCalledWith(1, "/tools/dprint", ["output-file-paths", "--config", configs[0]], {
		timeout: 60_000,
		cwd: "/workspace",
		maxBuffer: 64 * 1024 * 1024,
	});
	expect(execute).toHaveBeenNthCalledWith(2, "/tools/dprint", ["output-file-paths", "--config", configs[1]], {
		timeout: 60_000,
		cwd: "/workspace/packages/example",
		maxBuffer: 64 * 1024 * 1024,
	});
});

test("does nothing when no configs are discovered", async () => {
	const execute = mock(async () => {});

	expect(await warmupPlugins("/tools/dprint", [], execute)).toBeTrue();
	expect(execute).not.toHaveBeenCalled();
});

test("stops after a non-timeout warmup failure", async () => {
	const execute = mock(async () => {
		throw new Error("invalid config");
	});

	expect(await warmupPlugins("/tools/dprint", ["one.json", "two.json"], execute)).toBeFalse();
	expect(execute).toHaveBeenCalledTimes(1);
});

test("retries a hung warmup three times", () => {
	const execute = mock(async () => {
		throw Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
	});

	expect(warmupPlugins("/tools/dprint", ["dprint.json"], execute)).rejects.toThrow(
		"Plugin warmup kept hanging after 3 attempts",
	);
	expect(execute).toHaveBeenCalledTimes(3);
});
