#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

. (Join-Path $PSScriptRoot 'Release.Common.ps1')
trap { Write-UnhandledReleaseError $_; break }

$version = Get-RequiredEnvironmentVariable 'VERSION'
$defaultBranch = Get-RequiredEnvironmentVariable 'DEFAULT_BRANCH'
$sourceSha = Get-RequiredEnvironmentVariable 'SOURCE_SHA'
$null = Assert-StableReleaseVersion $version

if ((Get-RequiredEnvironmentVariable 'GITHUB_REF') -ne "refs/heads/$defaultBranch") {
	Write-ReleaseError "Releases must be prepared from $defaultBranch"
}

$package = Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json
if ($version -ne "v$($package.version)") {
	Write-ReleaseError "$version does not match package version $($package.version)"
}

$commit = Invoke-GitHubApi -Path "repos/{owner}/{repo}/commits/$sourceSha"
if (-not $commit.commit.verification.verified) {
	Write-ReleaseError "Source commit $sourceSha is not verified"
}

Assert-ReleaseDoesNotExist $version
if (Test-NativeCommand { git ls-remote --exit-code --tags origin "refs/tags/$version" }) {
	Write-ReleaseError "Tag $version already exists"
}
