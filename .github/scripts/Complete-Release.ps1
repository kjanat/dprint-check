#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

. (Join-Path $PSScriptRoot 'Release.Common.ps1')
trap { Write-UnhandledReleaseError $_; break }

$version = Get-RequiredEnvironmentVariable 'VERSION'
$owner = Get-RequiredEnvironmentVariable 'OWNER'
$repository = Get-RequiredEnvironmentVariable 'GH_REPO'
$defaultBranch = Get-RequiredEnvironmentVariable 'DEFAULT_BRANCH'
$releaseVersion = Assert-StableReleaseVersion $version

gh release verify $version
$releaseSha = (git -C release rev-parse HEAD).Trim()
$parents = @((git -C release rev-list --parents -n1 HEAD).Trim() -split '\s+')
if ($parents.Count -ne 2) {
	Write-ReleaseError "Release commit $releaseSha has $($parents.Count - 1) parents, expected 1"
}
$sourceSha = $parents[1]
$trailer = (git -C release log -1 '--format=%(trailers:key=Source-Commit,valueonly)').Trim()
if ($trailer -ne $sourceSha) {
	Write-ReleaseError "Release source trailer does not match its parent"
}
$commit = Invoke-GitHubApi -Path "repos/{owner}/{repo}/commits/$releaseSha"
if (-not $commit.commit.verification.verified) {
	Write-ReleaseError "Release commit $releaseSha is not verified"
}

$changedPaths = @(git -C release diff --name-only $sourceSha $releaseSha | Sort-Object)
$expectedPaths = @('SHA256SUMS', 'dist/main.mjs', 'dist/post.mjs') | Sort-Object
if (Compare-Object $expectedPaths $changedPaths) {
	Write-ReleaseError "Unexpected release paths: $($changedPaths -join ', ')"
}

Assert-ReleaseChecksum -Root release
foreach ($file in @('release/dist/main.mjs', 'release/dist/post.mjs')) {
	gh attestation verify $file `
		--owner $owner `
		--signer-workflow "$repository/.github/workflows/release.yml" `
		--source-digest $sourceSha `
		--source-ref "refs/heads/$defaultBranch" `
		--deny-self-hosted-runners
}

git -C release worktree add --detach ../source $sourceSha
Push-Location source
try {
	bun install --frozen-lockfile
	bun run build
}
finally {
	Pop-Location
}
Assert-FilesIdentical source/dist/main.mjs release/dist/main.mjs
Assert-FilesIdentical source/dist/post.mjs release/dist/post.mjs

New-Item -ItemType Directory -Path published/dist -Force | Out-Null
gh release download $version --pattern SHA256SUMS --dir published
gh release download $version --pattern main.mjs --pattern post.mjs --dir published/dist
foreach ($file in @('published/SHA256SUMS', 'published/dist/main.mjs', 'published/dist/post.mjs')) {
	gh release verify-asset $version $file
}
Assert-ReleaseChecksum -Root published
Assert-FilesIdentical release/SHA256SUMS published/SHA256SUMS
Assert-FilesIdentical release/dist/main.mjs published/dist/main.mjs
Assert-FilesIdentical release/dist/post.mjs published/dist/post.mjs

$stableTags = Get-StableReleaseTag (Get-ReleaseHistory)
$major = "v$($releaseVersion.Major)"
$minor = "v$($releaseVersion.Major).$($releaseVersion.Minor)"
$latestMinor = Get-LatestStableReleaseVersion -Tags $stableTags -Prefix $minor
$latestMajor = Get-LatestStableReleaseVersion -Tags $stableTags -Prefix $major

if ($latestMinor -eq $version) {
	Update-FloatingTag -Tag $minor -Sha $releaseSha
}
else {
	Write-Output "Leaving $minor unchanged; latest stable release is $($latestMinor ?? 'none')"
}
if ($latestMajor -eq $version) {
	Update-FloatingTag -Tag $major -Sha $releaseSha
}
else {
	Write-Output "Leaving $major unchanged; latest stable release is $($latestMajor ?? 'none')"
}
