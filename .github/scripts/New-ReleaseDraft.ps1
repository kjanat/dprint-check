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
$releaseVersion = Assert-StableReleaseVersion $version
Assert-ReleaseChecksum -Root candidate
Assert-ReleaseDoesNotExist $version

$releasePaths = @(Get-ReleasePath -Root candidate)
$licensePaths = @(Get-RootLicensePath -Root '.')
$readmePath = Join-Path (Get-RequiredEnvironmentVariable 'RUNNER_TEMP') 'release-README.md'
$readme = Format-ReleaseReadme `
	-RepositoryUrl "$serverUrl/$repository" `
	-Version $version `
	-SourceSha $sourceSha `
	-AttestationUrl $attestationUrl `
	-ReleasePath $releasePaths `
	-LicensePath $licensePaths
[IO.File]::WriteAllText($readmePath, $readme, [Text.UTF8Encoding]::new($false))
$releaseTree = (Invoke-GitHubApi -Method POST -Path 'repos/{owner}/{repo}/git/trees' -Body @{
		tree = @(
			@{ path = 'action.yml'; mode = '100644'; type = 'blob'; sha = Invoke-GitBlobCreation 'action.yml' }
			@{ path = 'README.md'; mode = '100644'; type = 'blob'; sha = Invoke-GitBlobCreation $readmePath }
			foreach ($path in $licensePaths) {
				@{ path = $path; mode = '100644'; type = 'blob'; sha = Invoke-GitBlobCreation $path }
			}
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
$release = Wait-ReleaseByUrl $createdReleaseUrl
if ($null -eq $release) {
	Write-ReleaseError "Could not identify the created draft: $createdReleaseUrl"
}
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
$releaseUrl = "$serverUrl/$repository/releases/tag/$version"
$major = "v$($releaseVersion.Major)"
$minor = "$major.$($releaseVersion.Minor)"
$summary = @"
## $version prepared

Preparation and pre-publication verification succeeded for [$version]($releaseUrl).

> [!IMPORTANT]
> If the publish job is awaiting approval, review the prepared release, then select **Review deployments** at the top of this run and approve the ``release`` environment.
>
> Do not publish the draft manually or dispatch this workflow again. The gated job publishes the release and moves ``$major`` and ``$minor`` only after final verification passes.
"@
[IO.File]::AppendAllText($summaryPath, $summary, [Text.UTF8Encoding]::new($false))
