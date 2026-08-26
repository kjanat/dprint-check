#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

. (Join-Path $PSScriptRoot 'Release.Common.ps1')
trap { Write-UnhandledReleaseError $_; break }

$owner = Get-RequiredEnvironmentVariable 'OWNER'
$repository = Get-RequiredEnvironmentVariable 'GH_REPO'
$sourceSha = Get-RequiredEnvironmentVariable 'SOURCE_SHA'
$defaultBranch = Get-RequiredEnvironmentVariable 'DEFAULT_BRANCH'

Assert-ReleaseChecksum -Root candidate

$releasePaths = @(Get-ReleasePath -Root candidate)
$bundlePaths = @(Get-ReleaseBundlePath -Root candidate)
foreach ($path in $bundlePaths) {
	$file = Join-Path candidate $path
	gh attestation verify $file `
		--owner $owner `
		--signer-workflow "$repository/.github/workflows/release.yml" `
		--source-digest $sourceSha `
		--source-ref "refs/heads/$defaultBranch" `
		--deny-self-hosted-runners
}

npm run build
Assert-ReleaseChecksum -Root .
foreach ($path in $releasePaths) {
	Assert-FilesIdentical $path (Join-Path candidate $path)
}
