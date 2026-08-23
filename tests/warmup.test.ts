import { DPRINT, ENVIRONMENT } from "#lib/contracts";
import { WARMUP_ATTEMPTS, WARMUP_MAX_BUFFER, WARMUP_TIMEOUT_MS, warmupPlugins } from "#lib/warmup";
import { TEST_DPRINT_BINARY, useTestContext } from "#test/helpers";
import { expect, mock, spyOn, test } from "bun:test";

const context = useTestContext();

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

	expect(await warmupPlugins(TEST_DPRINT_BINARY, configs, execute)).toBeTrue();
	expect(maximumActive).toBe(1);
	expect(execute).toHaveBeenNthCalledWith(1, TEST_DPRINT_BINARY, [
		DPRINT.command.warmup,
		DPRINT.command.config,
		configs[0],
	], {
		timeout: WARMUP_TIMEOUT_MS,
		cwd: "/workspace",
		maxBuffer: WARMUP_MAX_BUFFER,
	});
	expect(execute).toHaveBeenNthCalledWith(2, TEST_DPRINT_BINARY, [
		DPRINT.command.warmup,
		DPRINT.command.config,
		configs[1],
	], {
		timeout: WARMUP_TIMEOUT_MS,
		cwd: "/workspace/packages/example",
		maxBuffer: WARMUP_MAX_BUFFER,
	});
});

test("does nothing when no configs are discovered", async () => {
	const execute = mock(async () => {});

	expect(await warmupPlugins(TEST_DPRINT_BINARY, [], execute)).toBeTrue();
	expect(execute).not.toHaveBeenCalled();
});

test("warms a remote config from the workspace", async () => {
	const workspace = "/workspace";
	const config = "https://example.com/configs/dprint.json";
	context.setEnvironment(ENVIRONMENT.githubWorkspace, workspace);
	const execute = mock(async () => {});

	expect(await warmupPlugins(TEST_DPRINT_BINARY, [config], execute)).toBeTrue();
	expect(execute).toHaveBeenCalledWith(
		TEST_DPRINT_BINARY,
		[DPRINT.command.warmup, DPRINT.command.config, config],
		{
			timeout: WARMUP_TIMEOUT_MS,
			cwd: workspace,
			maxBuffer: WARMUP_MAX_BUFFER,
		},
	);
});

test("stops after a non-timeout warmup failure", async () => {
	const execute = mock(async () => {
		throw new Error("invalid config");
	});
	const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);

	try {
		expect(await warmupPlugins(TEST_DPRINT_BINARY, ["one.json", "two.json"], execute)).toBeFalse();
		expect(execute).toHaveBeenCalledTimes(1);
		expect(stdout).toHaveBeenCalledWith("::warning::Plugin warmup failed: invalid config\n");
	} finally {
		stdout.mockRestore();
	}
});

test(`retries a hung warmup ${WARMUP_ATTEMPTS} times`, () => {
	const execute = mock(async () => {
		throw Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
	});

	expect(warmupPlugins(TEST_DPRINT_BINARY, ["dprint.json"], execute)).rejects.toThrow(
		`Plugin warmup kept hanging after ${WARMUP_ATTEMPTS} attempts`,
	);
	expect(execute).toHaveBeenCalledTimes(WARMUP_ATTEMPTS);
});
