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
$serverUrl = Get-RequiredEnvironmentVariable 'GITHUB_SERVER_URL'
$releaseVersion = Assert-StableReleaseVersion $version

gh release verify $version
$releaseSha = (git -C release rev-parse HEAD).Trim()
$parents = @((git -C release rev-list --parents -n1 HEAD).Trim() -split '\s+')
if ($parents.Count -ne 2) {
	Write-ReleaseError "Release commit $releaseSha has $($parents.Count - 1) parents, expected 1"
}
$sourceSha = $parents[1]
$checkedOutSourceSha = (git -C source rev-parse HEAD).Trim()
if ($checkedOutSourceSha -ne $sourceSha) {
	Write-ReleaseError "Checked-out source $checkedOutSourceSha does not match release parent $sourceSha"
}
$trailer = Get-GitTrailerValue -RepositoryPath release -Key 'Source-Commit'
if ($trailer -ne $sourceSha) {
	Write-ReleaseError "Release source trailer does not match its parent"
}
$attestationUrl = Get-GitTrailerValue -RepositoryPath release -Key 'Attestation-URL'
if ($attestationUrl -notmatch "^$([regex]::Escape("$serverUrl/$repository"))/attestations/\d+$") {
	Write-ReleaseError "Release commit has an invalid attestation URL"
}
$commit = Invoke-GitHubApi -Path "repos/{owner}/{repo}/commits/$releaseSha"
if (-not $commit.commit.verification.verified) {
	Write-ReleaseError "Release commit $releaseSha is not verified"
}

$releasePaths = @(Get-ReleasePath -Root release)
$bundlePaths = @(Get-ReleaseBundlePath -Root release)
$licensePaths = @(Get-RootLicensePath -Root source)
$packagePaths = @(Get-ActionPackagePath -Root release -LicensePath $licensePaths)
$sourcePaths = @(Get-ActionSourcePath -Root release -LicensePath $licensePaths)
$treePaths = @(git -C release ls-tree -r --name-only $releaseSha | Sort-Object)
$expectedPaths = @($packagePaths | Sort-Object)
if (Compare-Object $expectedPaths $treePaths) {
	Write-ReleaseError "Unexpected release tree: $($treePaths -join ', ')"
}

Assert-ReleaseChecksum -Root release
foreach ($path in $bundlePaths) {
	$file = Join-Path release $path
	gh attestation verify $file `
		--owner $owner `
		--signer-workflow "$repository/.github/workflows/release.yml" `
		--source-digest $sourceSha `
		--source-ref "refs/heads/$defaultBranch" `
		--deny-self-hosted-runners
}

Push-Location source
try {
	bun install --frozen-lockfile
	bun run build
}
finally {
	Pop-Location
}
Assert-ReleaseChecksum -Root source
foreach ($path in $sourcePaths) {
	Assert-FilesIdentical (Join-Path source $path) (Join-Path release $path)
}
$expectedReadme = Format-ReleaseReadme `
	-RepositoryUrl "$serverUrl/$repository" `
	-Version $version `
	-SourceSha $sourceSha `
	-AttestationUrl $attestationUrl `
	-ReleasePath $releasePaths `
	-LicensePath $licensePaths
$actualReadme = [IO.File]::ReadAllText((Join-Path release 'README.md'))
if ($actualReadme -cne $expectedReadme) {
	Write-ReleaseError 'Generated release README does not match its verified release details'
}

for ($index = 0; $index -lt $releasePaths.Count; $index++) {
	$path = $releasePaths[$index]
	$assetName = Split-Path -Leaf $path
	$file = Join-Path published $path
	$directory = Split-Path -Parent $file
	New-Item -ItemType Directory -Path $directory -Force | Out-Null
	gh release download $version --pattern $assetName --dir $directory
	gh release verify-asset $version $file | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
	if ($index -lt $releasePaths.Count - 1) {
		Write-Output ''
	}
}
Assert-ReleaseChecksum -Root published
foreach ($path in $releasePaths) {
	Assert-FilesIdentical (Join-Path release $path) (Join-Path published $path)
}

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

Update-ReleaseBadgeCache -Repository $repository -Version $version

$summaryPath = Get-RequiredEnvironmentVariable 'GITHUB_STEP_SUMMARY'
$runNumber = Get-RequiredEnvironmentVariable 'GITHUB_RUN_NUMBER'
$runId = Get-RequiredEnvironmentVariable 'GITHUB_RUN_ID'
$releaseUrl = "$serverUrl/$repository/releases/tag/$version"
$verificationCommand = Format-ReleaseVerificationCommand `
	-RepositoryUrl "$serverUrl/$repository" `
	-Version $version `
	-SourceSha $sourceSha `
	-ReleasePath $releasePaths
$summary = @"
## $version finalized

- Release: [$version]($releaseUrl)
- Tagged Action tree: [$version]($serverUrl/$repository/tree/$version)
- Source commit: [$($sourceSha.Substring(0, 7))]($serverUrl/$repository/commit/$sourceSha)
- Signed release commit: [$($releaseSha.Substring(0, 7))]($serverUrl/$repository/commit/$releaseSha)
- Bundle provenance: [view attestation]($attestationUrl)
- Published assets: checksums and release attestations verified
- Independent rebuild: byte-for-byte identical
- Floating tags: [$major]($serverUrl/$repository/tree/$major), [$minor]($serverUrl/$repository/tree/$minor)
- Finalization run: [#$runNumber]($serverUrl/$repository/actions/runs/$runId)

### Verify independently

~~~sh
$verificationCommand
~~~
"@
[IO.File]::AppendAllText($summaryPath, $summary, [Text.UTF8Encoding]::new($false))
