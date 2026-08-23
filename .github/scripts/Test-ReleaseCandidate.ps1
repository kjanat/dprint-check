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
foreach ($file in @('candidate/dist/main.mjs', 'candidate/dist/post.mjs')) {
	gh attestation verify $file `
		--owner $owner `
		--signer-workflow "$repository/.github/workflows/release.yml" `
		--source-digest $sourceSha `
		--source-ref "refs/heads/$defaultBranch" `
		--deny-self-hosted-runners
}

bun run build
Assert-FilesIdentical dist/main.mjs candidate/dist/main.mjs
Assert-FilesIdentical dist/post.mjs candidate/dist/post.mjs
