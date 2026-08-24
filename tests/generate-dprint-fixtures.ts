import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const WORKSPACE = "/workspace";
const FIXTURE_ROOT = new URL("./fixtures/dprint/", import.meta.url);
const DPRINT_COMMAND = ["bunx", "--silent", "dprint@0.56.1"] as const;

const inputs = {
	"line-endings.ts": "export const lineEndings = true;\r\nexport const secondLine = true;\r\n",
	"markdown.md": "#Heading\n\n* first\n* second\n\nThis   sentence has   irregular spacing.\n",
	"noncontiguous.ts": [
		"export const first={value:1}",
		"",
		"const untouchedOne = 1;",
		"const untouchedTwo = 2;",
		"const untouchedThree = 3;",
		"const untouchedFour = 4;",
		"const untouchedFive = 5;",
		"const untouchedSix = 6;",
		"",
		"export const second={value:2}",
		"",
	].join("\n"),
	"powershell.ps1": "function Test-Thing{param([string]$Name)if($Name-eq'value'){Write-Output $Name}}\n",
	"typescript.ts": [
		"export const example={alpha:1,beta:2,gamma:[1,2,3],nested:{enabled:true,value:\"long value that should be represented in a real dprint diff\"}}",
		"",
		"export function add(a:number,b:number){return a+b}",
		"",
	].join("\n"),
} as const;

const config = {
	lineWidth: 80,
	useTabs: true,
	plugins: [
		"npm:@dprint/json@0.23.0",
		"npm:@dprint/markdown@0.22.1",
		"npm:dprint-plugin-yaml@0.6.0",
		"npm:@dprint/typescript@0.96.1",
		"https://plugins.dprint.dev/kjanat/pwsh-0.2.0.wasm",
	],
};
const debugConfig = { ...config, plugins: ["npm:@dprint/typescript@0.96.1"] };

interface Capture {
	stderr: string;
	stdout: string;
}

const fixtureEnvironment = (directory: string): Record<string, string | undefined> => ({
	...process.env,
	DPRINT_CACHE_DIR: join(directory, "cache"),
	DPRINT_GLOB_READ_THREADS: "1",
	DPRINT_MAX_THREADS: "1",
	HOME: join(directory, "home"),
	NO_COLOR: "true",
});

const normalize = (output: string, directory: string): string =>
	output
		.replaceAll(directory, WORKSPACE)
		.replaceAll(directory.replaceAll("\\", "/"), WORKSPACE)
		.replace(/incremental\/\d+/gu, "incremental/<hash>")
		.replace(/\*\*\/\*\.\{([^}]+)\}/gu, (_match, extensions: string) =>
			`**/*.{${extensions.split(",").toSorted().join(",")}}`)
		.replace(/ in \d+ms/gu, " in <duration>")
		.replace(/Thread count: \d+/gu, "Thread count: <count>");

const capture = async (
	directory: string,
	files: readonly string[],
	listDifferent = false,
	configPath = "dprint.json",
): Promise<Capture> => {
	const args = ["check", "--config", configPath, "--log-level", "debug"];
	if (listDifferent) args.push("--list-different");
	args.push(...files);
	const child = Bun.spawn([...DPRINT_COMMAND, ...args], {
		cwd: directory,
		env: fixtureEnvironment(directory),
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 20) throw new Error(`Expected dprint check to exit with 20, received ${exitCode}: ${stderr}`);
	const normalizedStdout = normalize(stdout, directory);
	const stableStdout = !listDifferent && files.length > 1
		? normalizedStdout.split("--\n").filter(Boolean).toSorted().map(section => `${section}--\n`).join("")
		: normalizedStdout;
	return {
		stderr: normalize(stderr, directory),
		stdout: listDifferent ? `${stableStdout.trimEnd().split("\n").toSorted().join("\n")}\n` : stableStdout,
	};
};

const writeFixture = async (path: string, contents: string): Promise<void> => {
	const url = new URL(path, FIXTURE_ROOT);
	await mkdir(dirname(url.pathname), { recursive: true });
	await writeFile(url, contents, "utf8");
};

const directory = await mkdtemp(join(tmpdir(), "dprint-check-fixtures-"));
try {
	await mkdir(join(directory, "home"));
	await writeFile(join(directory, "dprint.json"), `${JSON.stringify(config, undefined, "\t")}\n`);
	await writeFile(join(directory, "dprint-debug.json"), `${JSON.stringify(debugConfig, undefined, "\t")}\n`);
	await Promise.all(Object.entries(inputs).map(([name, contents]) => writeFile(join(directory, name), contents)));

	for (const configPath of ["dprint.json", "dprint-debug.json"]) {
		const prime = Bun.spawn([...DPRINT_COMMAND, "output-file-paths", "--config", configPath], {
			cwd: directory,
			env: fixtureEnvironment(directory),
			stderr: "pipe",
			stdout: "ignore",
		});
		const [primeError, primeExitCode] = await Promise.all([new Response(prime.stderr).text(), prime.exited]);
		if (primeExitCode !== 0) throw new Error(`Could not prime dprint plugins: ${primeError}`);
	}

	const checkTypescript = await capture(directory, ["typescript.ts"]);
	const checkMarkdown = await capture(directory, ["markdown.md"]);
	const checkPowerShell = await capture(directory, ["powershell.ps1"]);
	const checkNoncontiguous = await capture(directory, ["noncontiguous.ts"]);
	const checkLineEndings = await capture(directory, ["line-endings.ts"]);
	const checkMultifile = await capture(directory, ["typescript.ts", "markdown.md", "powershell.ps1"]);
	const listDifferent = await capture(directory, ["typescript.ts", "markdown.md", "powershell.ps1"], true);
	const checkDebug = await capture(directory, ["typescript.ts"], false, "dprint-debug.json");
	const listDifferentDebug = await capture(
		directory,
		["typescript.ts", "noncontiguous.ts"],
		true,
		"dprint-debug.json",
	);

	await Promise.all([
		writeFixture("stdout/check-typescript.txt", checkTypescript.stdout),
		writeFixture("stdout/check-markdown.txt", checkMarkdown.stdout),
		writeFixture("stdout/check-powershell.txt", checkPowerShell.stdout),
		writeFixture("stdout/check-noncontiguous.txt", checkNoncontiguous.stdout),
		writeFixture("stdout/check-line-endings.txt", checkLineEndings.stdout),
		writeFixture("stdout/check-multifile.txt", checkMultifile.stdout),
		writeFixture("stdout/list-different.txt", listDifferent.stdout),
		writeFixture("stderr/check-debug.txt", checkDebug.stderr),
		writeFixture("stderr/list-different-debug.txt", listDifferentDebug.stderr),
	]);
} finally {
	await rm(directory, { recursive: true, force: true });
}
