import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { execFileAsync } from "#lib/exec";

const root = dirname(import.meta.dir);
const commonScript = join(root, ".github", "scripts", "Release.Common.ps1");
const invokePowerShell = async (script: string) =>
	(
		await execFileAsync(
			"pwsh",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ cwd: root },
		)
	).stdout.trimEnd();

describe("release PowerShell", () => {
	test("all release scripts parse", async () => {
		const output = await invokePowerShell(`
$failed = $false
Get-ChildItem '.github/scripts/*.ps1' | ForEach-Object {
	$tokens = $null
	$errors = $null
	[void][Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors)
	foreach ($error in $errors) {
		$failed = $true
		Write-Error ("{0}:{1}: {2}" -f $_.FullName, $error.Extent.StartLineNumber, $error.Message)
	}
}
if ($failed) { exit 1 }
'valid'
`);
		expect(output).toBe("valid");
	});

	test("annotates release errors before throwing", async () => {
		const annotation = await invokePowerShell(`
. '${commonScript}'
try { Write-ReleaseError "bad%line\`nnext" } catch {}
exit 0
`);
		expect(annotation).toBe("::error::bad%25line%0Anext");
		const failure = await invokePowerShell(`
. '${commonScript}'
trap { Write-UnhandledReleaseError $_; break }
Write-ReleaseError 'release failed'
`).then(
			() => undefined,
			error => error as Error & { stdout: string },
		);
		expect(failure).toBeInstanceOf(Error);
		expect(failure?.message).toContain("release failed");
		expect(failure?.stdout.trimEnd()).toBe("::error::release failed");
	});

	test("consumes expected native probe failures", async () => {
		const output = await invokePowerShell(`
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
. '${commonScript}'
$succeeded = Test-NativeCommand { pwsh -NoProfile -NonInteractive -Command 'exit 7' }
"$succeeded|$LASTEXITCODE"
`);
		expect(output).toBe("False|0");
	});

	test("renders release provenance and source changes before generated notes", async () => {
		const output = await invokePowerShell(`
. '${commonScript}'
$commits = @([pscustomobject]@{
	sha = '3333333333333333333333333333333333333333'
	commit = [pscustomobject]@{ message = "Strengthen CI and release verification\`n\`nDetails" }
})
$notes = Format-ReleaseNote -Commits $commits -RepositoryUrl 'https://github.com/dprint/check' -Version 'v3.0.0' -SourceSha '1111111111111111111111111111111111111111' -ReleaseSha '2222222222222222222222222222222222222222' -AttestationUrl 'https://github.com/dprint/check/attestations/12345678' -ReleasePath @('SHA256SUMS', 'dist/action.mjs')
$notes | ConvertTo-Json -Compress
`);
		const notes = JSON.parse(output) as string;
		expect(notes).toContain("## Provenance and verification");
		expect(notes).toContain(
			"[GitHub artifact attestation](https://github.com/dprint/check/attestations/12345678)",
		);
		expect(notes).toContain(
			"[`SHA256SUMS`](https://github.com/dprint/check/releases/download/v3.0.0/SHA256SUMS)",
		);
		expect(notes).toContain("gh release verify v3.0.0 -R dprint/check");
		expect(notes).toContain("## Source changes");
		expect(notes).toContain(
			"[`3333333`](https://github.com/dprint/check/commit/3333333333333333333333333333333333333333): Strengthen CI and release verification",
		);
	});

	test("renders provenance for the first release without source changes", async () => {
		const output = await invokePowerShell(`
. '${commonScript}'
$notes = Format-ReleaseNote -Commits @() -RepositoryUrl 'https://github.com/dprint/check' -Version 'v3.0.0' -SourceSha '1111111111111111111111111111111111111111' -ReleaseSha '2222222222222222222222222222222222222222' -AttestationUrl 'https://github.com/dprint/check/attestations/12345678' -ReleasePath @('SHA256SUMS', 'dist/action.mjs')
$notes | ConvertTo-Json -Compress
`);
		const notes = JSON.parse(output) as string;
		expect(notes).toContain("## Provenance and verification");
		expect(notes).not.toContain("## Source changes");
	});

	test("selects previous and floating releases by semantic version", async () => {
		const output = await invokePowerShell(`
. '${commonScript}'
$tags = @('v3.0.2', 'v3.1.0', 'v3.0.3')
@{
	previous = Get-PreviousStableReleaseVersion -Tags $tags -Version 'v3.1.1'
	minor = Get-LatestStableReleaseVersion -Tags $tags -Prefix 'v3.0'
	major = Get-LatestStableReleaseVersion -Tags $tags -Prefix 'v3'
} | ConvertTo-Json -Compress
`);
		expect(JSON.parse(output)).toEqual({ previous: "v3.1.0", minor: "v3.0.3", major: "v3.1.0" });
	});

	test("returns no release outside an empty semantic version range", async () => {
		const output = await invokePowerShell(`
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. '${commonScript}'
@{
	previous = Get-PreviousStableReleaseVersion -Tags @() -Version 'v3.0.0'
	latest = Get-LatestStableReleaseVersion -Tags @('v2.9.9') -Prefix 'v3'
} | ConvertTo-Json -Compress
`);
		expect(JSON.parse(output)).toEqual({ previous: null, latest: null });
	});
});
