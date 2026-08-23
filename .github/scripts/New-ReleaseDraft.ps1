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

$sourceTree = (Invoke-GitHubApi -Path "repos/{owner}/{repo}/git/commits/$sourceSha").tree.sha
$releaseTree = (Invoke-GitHubApi -Method POST -Path 'repos/{owner}/{repo}/git/trees' -Body @{
		base_tree = $sourceTree
		tree      = @(
			@{ path = 'dist/main.mjs'; mode = '100644'; type = 'blob'; sha = Invoke-GitBlobCreation 'candidate/dist/main.mjs' }
			@{ path = 'dist/post.mjs'; mode = '100644'; type = 'blob'; sha = Invoke-GitBlobCreation 'candidate/dist/post.mjs' }
			@{ path = 'SHA256SUMS'; mode = '100644'; type = 'blob'; sha = Invoke-GitBlobCreation 'candidate/SHA256SUMS' }
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
if ($previousVersion) {
	$releaseOptions += '--notes-start-tag', $previousVersion
	$previousCommit = Invoke-GitHubApi -Path "repos/{owner}/{repo}/commits/$previousVersion"
	$previousSource = Get-SourceCommit -Message $previousCommit.commit.message -Fallback $previousCommit.sha
	$comparison = Invoke-GitHubApi -Path "repos/{owner}/{repo}/compare/$previousSource...$sourceSha"
	$notes = Format-ReleaseNote -Commits @($comparison.commits) -RepositoryUrl "$serverUrl/$repository"
	if ($notes) {
		$releaseOptions += '--notes', $notes
	}
}

$releaseArguments = @(
	'release', 'create', $version,
	'candidate/SHA256SUMS',
	'candidate/dist/main.mjs',
	'candidate/dist/post.mjs',
	'--target', $releaseSha,
	'--title', $version
)
$releaseArguments += $releaseOptions
$releaseArguments += '--draft'
gh @releaseArguments

$release = ConvertFrom-NativeJson (gh release view $version --json 'assets,isDraft,tagName,targetCommitish,url')
if (-not $release.isDraft) { Write-ReleaseError "Release $version is not a draft" }
if ($release.tagName -ne $version) { Write-ReleaseError "Draft tag is $($release.tagName), expected $version" }
if ($release.targetCommitish -ne $releaseSha) {
	Write-ReleaseError "Draft targets $($release.targetCommitish), expected $releaseSha"
}
$assetNames = @($release.assets | ForEach-Object name | Sort-Object)
$expectedAssets = @('main.mjs', 'post.mjs', 'SHA256SUMS') | Sort-Object
if (Compare-Object $expectedAssets $assetNames) {
	Write-ReleaseError "Draft release assets do not match the candidate"
}

Add-GitHubOutput 'release-sha' $releaseSha
Add-GitHubOutput 'release-url' $release.url

$summaryPath = Get-RequiredEnvironmentVariable 'GITHUB_STEP_SUMMARY'
$runNumber = Get-RequiredEnvironmentVariable 'GITHUB_RUN_NUMBER'
$runId = Get-RequiredEnvironmentVariable 'GITHUB_RUN_ID'
$releaseUrl = "$serverUrl/$repository/releases/tag/$version"
$summary = @"
## $version is ready for review

- Draft release: [Review $version]($releaseUrl)
- Source commit: [$($sourceSha.Substring(0, 7))]($serverUrl/$repository/commit/$sourceSha)
- Signed release commit: [$($releaseSha.Substring(0, 7))]($serverUrl/$repository/commit/$releaseSha)
- Tagged Action tree: [$version]($serverUrl/$repository/tree/$version) (available after publication)
- Preparation run: [#$runNumber]($serverUrl/$repository/actions/runs/$runId)
- Release workflow: [Open dispatch page]($serverUrl/$repository/actions/workflows/release.yml)

### Dispatch input

~~~text
$version
~~~

Or prepare it with GitHub CLI:

~~~sh
gh workflow run release.yml -R $repository --ref $defaultBranch -f version=$version
~~~

- Independent rebuild: byte-for-byte identical
- Bundle provenance: [view attestation]($attestationUrl)

Publish the draft only after immutable releases are enabled.
"@
[IO.File]::AppendAllText($summaryPath, $summary, [Text.UTF8Encoding]::new($false))
