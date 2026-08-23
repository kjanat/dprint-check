#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

. (Join-Path $PSScriptRoot 'Release.Common.ps1')
trap { Write-UnhandledReleaseError $_; break }

$version = Get-RequiredEnvironmentVariable 'VERSION'
$sourceSha = Get-RequiredEnvironmentVariable 'SOURCE_SHA'
$defaultBranch = Get-RequiredEnvironmentVariable 'DEFAULT_BRANCH'
$repository = Get-RequiredEnvironmentVariable 'GH_REPO'
$serverUrl = Get-RequiredEnvironmentVariable 'GITHUB_SERVER_URL'
$attestationUrl = Get-RequiredEnvironmentVariable 'ATTESTATION_URL'
$null = Assert-StableReleaseVersion $version
Assert-ReleaseChecksum -Root candidate
Assert-ReleaseDoesNotExist $version

$releasePaths = @(Get-ReleasePath -Root candidate)
$sourceTree = (Invoke-GitHubApi -Path "repos/{owner}/{repo}/git/commits/$sourceSha").tree.sha
$releaseTree = (Invoke-GitHubApi -Method POST -Path 'repos/{owner}/{repo}/git/trees' -Body @{
		base_tree = $sourceTree
		tree      = @(
			foreach ($path in $releasePaths) {
				@{ path = $path; mode = '100644'; type = 'blob'; sha = Invoke-GitBlobCreation (Join-Path candidate $path) }
			}
		)
	}).sha

$defaultSha = (Invoke-GitHubApi -Path "repos/{owner}/{repo}/git/ref/heads/$defaultBranch").object.sha
if ($defaultSha -ne $sourceSha) {
	Write-ReleaseError "Default branch advanced from $sourceSha to $defaultSha"
}

$releaseCommit = Invoke-GitHubApi -Method POST -Path 'repos/{owner}/{repo}/git/commits' -Body @{
	message = "chore(release): build $version`n`nSource-Commit: $sourceSha`nAttestation-URL: $attestationUrl"
	tree    = $releaseTree
	parents = @($sourceSha)
}
$releaseSha = $releaseCommit.sha
if (-not $releaseCommit.verification.verified) {
	Write-ReleaseError "GitHub did not sign release commit $releaseSha"
}

$stableTags = Get-StableReleaseTag (Get-ReleaseHistory)
$previousVersion = Get-PreviousStableReleaseVersion -Tags $stableTags -Version $version
$releaseOptions = @('--generate-notes')
$commits = @()
if ($previousVersion) {
	$releaseOptions += '--notes-start-tag', $previousVersion
	$previousCommit = Invoke-GitHubApi -Path "repos/{owner}/{repo}/commits/$previousVersion"
	$previousSource = Get-SourceCommit -Message $previousCommit.commit.message -Fallback $previousCommit.sha
	$comparison = Invoke-GitHubApi -Path "repos/{owner}/{repo}/compare/$previousSource...$sourceSha"
	$commits = @($comparison.commits)
}
$notes = Format-ReleaseNote `
	-Commits $commits `
	-RepositoryUrl "$serverUrl/$repository" `
	-Version $version `
	-SourceSha $sourceSha `
	-ReleaseSha $releaseSha `
	-AttestationUrl $attestationUrl `
	-ReleasePath $releasePaths
$releaseOptions += '--notes', $notes

$releaseArguments = @('release', 'create', $version)
$releaseArguments += @($releasePaths | ForEach-Object { Join-Path candidate $_ })
$releaseArguments += @(
	'--target', $releaseSha,
	'--title', $version
)
$releaseArguments += $releaseOptions
$releaseArguments += '--draft'
Assert-ReleaseDoesNotExist $version
$releaseOutput = @(& gh @releaseArguments)
$createdReleaseUrl = ([string] ($releaseOutput | Select-Object -Last 1)).Trim()

if ([string]::IsNullOrWhiteSpace($createdReleaseUrl)) {
	Write-ReleaseError "GitHub CLI did not return the created draft URL"
}
$matchingReleases = @(Get-ReleaseHistory | Where-Object { $_.html_url -eq $createdReleaseUrl })
if ($matchingReleases.Count -ne 1) {
	Write-ReleaseError "Could not identify the created draft: $createdReleaseUrl"
}
$release = $matchingReleases[0]
if (-not $release.draft) { Write-ReleaseError "Release $version is not a draft" }
if ($release.tag_name -ne $version) { Write-ReleaseError "Draft tag is $($release.tag_name), expected $version" }
if ($release.target_commitish -ne $releaseSha) {
	Write-ReleaseError "Draft targets $($release.target_commitish), expected $releaseSha"
}
$assetNames = @($release.assets | ForEach-Object name | Sort-Object)
$expectedAssets = @(Get-ReleaseAssetName -Path $releasePaths | Sort-Object)
if (Compare-Object $expectedAssets $assetNames) {
	Write-ReleaseError "Draft release assets do not match the candidate"
}

Add-GitHubOutput 'release-sha' $releaseSha
Add-GitHubOutput 'release-url' $release.html_url

$summaryPath = Get-RequiredEnvironmentVariable 'GITHUB_STEP_SUMMARY'
$runNumber = Get-RequiredEnvironmentVariable 'GITHUB_RUN_NUMBER'
$runId = Get-RequiredEnvironmentVariable 'GITHUB_RUN_ID'
$releaseUrl = "$serverUrl/$repository/releases/tag/$version"
$editUrl = $release.html_url.Replace('/releases/tag/', '/releases/edit/')
$summary = @"
## $version is ready for review

- Draft release: [Review and publish $version]($editUrl)
- Published release: [$version]($releaseUrl) (available after publication)
- Source commit: [$($sourceSha.Substring(0, 7))]($serverUrl/$repository/commit/$sourceSha)
- Signed release commit: [$($releaseSha.Substring(0, 7))]($serverUrl/$repository/commit/$releaseSha)
- Tagged Action tree: [$version]($serverUrl/$repository/tree/$version) (available after publication)
- Preparation run: [#$runNumber]($serverUrl/$repository/actions/runs/$runId)

- Independent rebuild: byte-for-byte identical
- Bundle provenance: [view attestation]($attestationUrl)

Review the linked draft, then use **Publish release**. Do not dispatch this workflow again; publishing the draft triggers final verification.
"@
[IO.File]::AppendAllText($summaryPath, $summary, [Text.UTF8Encoding]::new($false))
