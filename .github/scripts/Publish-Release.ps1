#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

. (Join-Path $PSScriptRoot 'Release.Common.ps1')
trap { Write-UnhandledReleaseError $_; break }

$version = Get-RequiredEnvironmentVariable 'VERSION'
$releaseSha = Get-RequiredEnvironmentVariable 'RELEASE_SHA'
$releaseUrl = Get-RequiredEnvironmentVariable 'RELEASE_URL'
$null = Assert-StableReleaseVersion $version
Assert-ReleaseChecksum -Root candidate

$matches = @(Get-ReleaseHistory | Where-Object tag_name -EQ $version)
if ($matches.Count -ne 1) {
	Write-ReleaseError "Expected one release for $version, found $($matches.Count)"
}
$release = $matches[0]
if ($release.html_url -ne $releaseUrl) {
	Write-ReleaseError "Release URL is $($release.html_url), expected $releaseUrl"
}
if ($release.target_commitish -ne $releaseSha) {
	Write-ReleaseError "Release targets $($release.target_commitish), expected $releaseSha"
}
$assetNames = @($release.assets | ForEach-Object name | Sort-Object)
$expectedAssets = @(Get-ReleaseAssetName -Path (Get-ReleasePath -Root candidate) | Sort-Object)
if (Compare-Object $expectedAssets $assetNames) {
	Write-ReleaseError 'Draft release assets do not match the verified candidate'
}

if ($release.draft) {
	gh release edit $version --draft=false
}
else {
	Write-Output "$version is already published; continuing with final verification"
}

$published = @(Get-ReleaseHistory | Where-Object tag_name -EQ $version)
if ($published.Count -ne 1 -or $published[0].draft -or -not $published[0].published_at) {
	Write-ReleaseError "$version was not published"
}
if ($published[0].target_commitish -ne $releaseSha) {
	Write-ReleaseError "Published release targets $($published[0].target_commitish), expected $releaseSha"
}
