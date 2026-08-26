import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import { execFileAsync } from "#lib/exec";

const root = dirname(import.meta.dirname);
const commonScript = join(root, ".github", "scripts", "Release.Common.ps1");
const invokePowerShell = async (script: string) =>
	(
		await execFileAsync(
			"pwsh",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ cwd: root },
		)
	).stdout.trimEnd();

const invokeFailingPowerShell = (script: string): Promise<unknown> =>
	invokePowerShell(script).then(() => undefined, (error: unknown) => error);

function assertPowerShellFailure(value: unknown): asserts value is Error & { stdout: string } {
	assert.ok(value instanceof Error);
	assert.ok("stdout" in value);
	assert.ok(typeof value.stdout === "string");
}

const parseJson = (output: string): unknown => JSON.parse(output);

const parseJsonString = (output: string): string => {
	const value = parseJson(output);
	if (typeof value !== "string") throw new TypeError(`Expected a JSON string, received ${typeof value}`);
	return value;
};

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
		assert.strictEqual(output, "valid");
	});

	test("annotates release errors before throwing", async () => {
		const annotation = await invokePowerShell(`
. '${commonScript}'
try { Write-ReleaseError "bad%line\`nnext" } catch {}
exit 0
`);
		assert.strictEqual(annotation, "::error::bad%25line%0Anext");
		const failure = await invokeFailingPowerShell(`
. '${commonScript}'
trap { Write-UnhandledReleaseError $_; break }
Write-ReleaseError 'release failed'
`);
		assertPowerShellFailure(failure);
		assert.ok(failure.message.includes("release failed"));
		assert.strictEqual(failure.stdout.trimEnd(), "::error::release failed");
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
		assert.strictEqual(output, "False|0");
	});

	test("reads exactly one git trailer as a string", async () => {
		const output = await invokePowerShell(`
. '${commonScript}'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
try {
	git init --quiet $fixture
	git -C $fixture -c user.name=Test -c user.email=test@example.com -c commit.gpgsign=false commit --allow-empty --quiet -m "Release\`n\`nAttestation-URL: https://github.com/dprint/check/attestations/12345678"
	$value = Get-GitTrailerValue -RepositoryPath $fixture -Key 'Attestation-URL'
	@{ type = $value.GetType().FullName; value = $value } | ConvertTo-Json -Compress
}
finally {
	Remove-Item -Recurse -Force $fixture
}
`);
		assert.deepStrictEqual(parseJson(output), {
			type: "System.String",
			value: "https://github.com/dprint/check/attestations/12345678",
		});
	});

	test("defaults checksum operations to SHA256SUMS", async () => {
		const output = await invokePowerShell(`
. '${commonScript}'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
try {
	[void][IO.Directory]::CreateDirectory((Join-Path $fixture 'dist'))
	[IO.File]::WriteAllText((Join-Path $fixture 'dist/action.mjs'), 'bundle')
	[IO.File]::WriteAllText((Join-Path $fixture 'LICENSE'), 'license')
	$hash = (Get-FileHash (Join-Path $fixture 'dist/action.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
	[IO.File]::WriteAllText((Join-Path $fixture 'SHA256SUMS'), "$hash  dist/action.mjs\`n")
	Assert-ReleaseChecksum -Root $fixture
	$licenses = @(Get-RootLicensePath -Root $fixture)
	@{
		assets = @(Get-ReleasePath -Root $fixture)
		package = @(Get-ActionPackagePath -Root $fixture -LicensePath $licenses)
		source = @(Get-ActionSourcePath -Root $fixture -LicensePath $licenses)
	} | ConvertTo-Json -Compress
}
finally {
	Remove-Item -Recurse -Force $fixture
}
`);
		assert.deepStrictEqual(parseJson(output), {
			assets: ["SHA256SUMS", "dist/action.mjs"],
			package: [
				"action.yml",
				"README.md",
				"LICENSE",
				"SHA256SUMS",
				"dist/action.mjs",
			],
			source: ["action.yml", "LICENSE", "SHA256SUMS", "dist/action.mjs"],
		});
	});

	test("renders a self-contained README for the exact Action tag", async () => {
		const output = await invokePowerShell(`
. '${commonScript}'
$readme = Format-ReleaseReadme -RepositoryUrl 'https://github.com/dprint/check' -Version 'v3.0.0' -SourceSha '1111111111111111111111111111111111111111' -AttestationUrl 'https://github.com/dprint/check/attestations/12345678' -ReleasePath @('SHA256SUMS', 'dist/main.mjs', 'dist/post.mjs') -LicensePath @('LICENSE')
$readme | ConvertTo-Json -Compress
`);
		const readme = parseJsonString(output);
		assert.ok(readme.includes("# dprint/check v3.0.0"));
		assert.ok(readme.includes("- uses: dprint/check@v3.0.0"));
		assert.ok(
			readme.includes(
				"[`1111111`](https://github.com/dprint/check/commit/1111111111111111111111111111111111111111)",
			),
		);
		assert.ok(
			readme.includes(
				"[view on GitHub](https://github.com/dprint/check/attestations/12345678)",
			),
		);
		assert.ok(
			readme.includes(
				"[`LICENSE`](https://github.com/dprint/check/blob/v3.0.0/LICENSE)",
			),
		);
		assert.ok(readme.includes("release_dir=\"$(mktemp -d)\""));
		assert.ok(
			readme.includes(
				"test \"$(gh release view v3.0.0 -R dprint/check --json isDraft --jq .isDraft)\" = false",
			),
		);
		assert.ok(
			readme.includes(
				"gh release download v3.0.0 -R dprint/check --pattern main.mjs --dir \"$release_dir/dist\"",
			),
		);
		assert.ok(readme.includes("(cd \"$release_dir\" && sha256sum --check SHA256SUMS)"));
		assert.ok(
			readme.includes(
				"gh attestation verify \"$release_dir/dist/main.mjs\" --repo dprint/check --source-digest 1111111111111111111111111111111111111111",
			),
		);
		assert.ok(!readme.includes("gh release verify "));
	});

	test("builds exact-version release and tag badge URLs", async () => {
		const output = await invokePowerShell(`
. '${commonScript}'
@{
	release = Get-ReleaseBadgeUrl -Repository 'dprint/check' -Version 'v3.0.0'
	tag = Get-TagBadgeUrl -Repository 'dprint/check' -Version 'v3.0.0'
} | ConvertTo-Json -Compress
`);
		assert.deepStrictEqual(parseJson(output), {
			release:
				"https://img.shields.io/github/v/release/dprint/check?include_prereleases&sort=semver&filter=v3.0.0&display_name=release&style=flat-square",
			tag:
				"https://img.shields.io/github/v/tag/dprint/check?include_prereleases&sort=semver&filter=v3.0.0&label=tree&style=flat-square",
		});
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
		const notes = parseJsonString(output);
		assert.ok(notes.includes("## Provenance and verification"));
		assert.ok(
			notes.includes(
				"[GitHub artifact attestation](https://github.com/dprint/check/attestations/12345678)",
			),
		);
		assert.ok(
			notes.includes(
				"[`SHA256SUMS`](https://github.com/dprint/check/releases/download/v3.0.0/SHA256SUMS)",
			),
		);
		assert.ok(notes.includes("release_dir=\"$(mktemp -d)\""));
		assert.ok(
			notes.includes(
				"gh release download v3.0.0 -R dprint/check --pattern action.mjs --dir \"$release_dir/dist\"",
			),
		);
		assert.ok(
			notes.includes(
				"gh attestation verify \"$release_dir/dist/action.mjs\" --repo dprint/check --source-digest 1111111111111111111111111111111111111111",
			),
		);
		assert.ok(!notes.includes("gh release verify "));
		assert.ok(notes.includes("## Source changes"));
		assert.ok(
			notes.includes(
				"[`3333333`](https://github.com/dprint/check/commit/3333333333333333333333333333333333333333): Strengthen CI and release verification",
			),
		);
	});

	test("renders provenance for the first release without source changes", async () => {
		const output = await invokePowerShell(`
. '${commonScript}'
$notes = Format-ReleaseNote -Commits @() -RepositoryUrl 'https://github.com/dprint/check' -Version 'v3.0.0' -SourceSha '1111111111111111111111111111111111111111' -ReleaseSha '2222222222222222222222222222222222222222' -AttestationUrl 'https://github.com/dprint/check/attestations/12345678' -ReleasePath @('SHA256SUMS', 'dist/action.mjs')
$notes | ConvertTo-Json -Compress
`);
		const notes = parseJsonString(output);
		assert.ok(notes.includes("## Provenance and verification"));
		assert.ok(!notes.includes("## Source changes"));
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
		assert.deepStrictEqual(parseJson(output), { previous: "v3.1.0", minor: "v3.0.3", major: "v3.1.0" });
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
		assert.deepStrictEqual(parseJson(output), { previous: null, latest: null });
	});

	test("treats draft releases as existing versions", async () => {
		const failure = await invokeFailingPowerShell(`
. '${commonScript}'
function Get-ReleaseHistory {
	return @([pscustomobject]@{
		tag_name = 'v3.0.1'
		draft = $true
		html_url = 'https://github.com/dprint/check/releases/tag/untagged-draft'
	})
}
Assert-ReleaseDoesNotExist 'v3.0.1'
`);
		assertPowerShellFailure(failure);
		assert.ok(failure.message.includes("Release v3.0.1 already exists"));
		assert.ok(failure.stdout.includes("untagged-draft"));
	});

	test("waits for a newly created draft to appear in release history", async () => {
		const output = await invokePowerShell(`
. '${commonScript}'
$script:queries = 0
function Get-ReleaseHistory {
	$script:queries++
	if ($script:queries -lt 3) { return @() }
	return @([pscustomobject]@{
		tag_name = 'v3.0.1'
		draft = $true
		html_url = 'https://github.com/dprint/check/releases/tag/untagged-draft'
	})
}
$release = Wait-ReleaseByUrl 'https://github.com/dprint/check/releases/tag/untagged-draft' -Attempts 3 -DelaySeconds 0
@{ queries = $script:queries; url = $release.html_url } | ConvertTo-Json -Compress
`);
		assert.deepStrictEqual(parseJson(output), {
			queries: 3,
			url: "https://github.com/dprint/check/releases/tag/untagged-draft",
		});
	});
});
