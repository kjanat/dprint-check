#!/usr/bin/env pwsh
function Write-GitHubError([string] $Message) {
	$escaped = $Message.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
	Write-Output "::error::$escaped"
}

function Write-ReleaseError([string] $Message) {
	Write-GitHubError $Message
	$exception = [InvalidOperationException]::new($Message)
	$exception.Data['GitHubErrorEmitted'] = $true
	throw $exception
}

function Write-UnhandledReleaseError([Management.Automation.ErrorRecord] $ErrorRecord) {
	if ($ErrorRecord.Exception.Data['GitHubErrorEmitted'] -ne $true) {
		Write-GitHubError $ErrorRecord.Exception.Message
	}
}

function Get-RequiredEnvironmentVariable([string] $Name) {
	$value = [Environment]::GetEnvironmentVariable($Name)
	if ([string]::IsNullOrWhiteSpace($value)) {
		Write-ReleaseError "Missing required environment variable: $Name"
	}
	return $value
}

function Assert-StableReleaseVersion([string] $Version) {
	if ($Version -notmatch '^v\d+\.\d+\.\d+$') {
		Write-ReleaseError "Version must be a stable semantic version prefixed with v"
	}
	return [version] $Version.Substring(1)
}

function ConvertFrom-NativeJson([string[]] $Output) {
	return ($Output -join "`n") | ConvertFrom-Json
}

function Get-GitTrailerValue {
	param(
		[Parameter(Mandatory)] [string] $RepositoryPath,
		[Parameter(Mandatory)] [ValidatePattern('^[A-Za-z0-9-]+$')] [string] $Key
	)

	$values = @(
		git -C $RepositoryPath log -1 "--format=%(trailers:key=$Key,valueonly)" |
			Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
			ForEach-Object { ([string] $_).Trim() }
	)
	if ($values.Count -ne 1) {
		Write-ReleaseError "Release commit must contain exactly one $Key trailer, found $($values.Count)"
	}
	return [string] $values[0]
}

function Invoke-GitHubApi {
	param(
		[Parameter(Mandatory)] [string] $Path,
		[ValidateSet('GET', 'POST', 'PATCH', 'PUT', 'DELETE')] [string] $Method = 'GET',
		[object] $Body,
		[switch] $Paginate
	)

	$arguments = @('api')
	if ($Paginate) {
		$arguments += '--paginate', '--slurp'
	}
	if ($Method -ne 'GET') {
		$arguments += '--method', $Method
	}
	$arguments += $Path

	$requestPath = $null
	try {
		if ($null -ne $Body) {
			$requestPath = Join-Path (Get-RequiredEnvironmentVariable 'RUNNER_TEMP') "gh-request-$([guid]::NewGuid()).json"
			$json = $Body | ConvertTo-Json -Depth 20
			[IO.File]::WriteAllText($requestPath, $json, [Text.UTF8Encoding]::new($false))
			$arguments += '--input', $requestPath
		}
		return ConvertFrom-NativeJson (& gh @arguments)
	}
	finally {
		if ($requestPath) {
			Remove-Item -LiteralPath $requestPath -ErrorAction SilentlyContinue
		}
	}
}

function Test-NativeCommand([scriptblock] $Command) {
	$previousPreference = $PSNativeCommandUseErrorActionPreference
	try {
		$PSNativeCommandUseErrorActionPreference = $false
		& $Command *> $null
		$succeeded = $LASTEXITCODE -eq 0
		$global:LASTEXITCODE = 0
		return $succeeded
	}
	finally {
		$PSNativeCommandUseErrorActionPreference = $previousPreference
	}
}

function Add-GitHubOutput([string] $Name, [string] $Value) {
	$outputPath = Get-RequiredEnvironmentVariable 'GITHUB_OUTPUT'
	[IO.File]::AppendAllText($outputPath, "$Name=$Value`n", [Text.UTF8Encoding]::new($false))
}

function Get-ReleaseChecksumPath {
	return 'SHA256SUMS'
}

function Read-ReleaseChecksumEntry {
	param(
		[Parameter(Mandatory)] [string] $Root,
		[string] $Manifest
	)

	if ([string]::IsNullOrWhiteSpace($Manifest)) {
		$Manifest = Get-ReleaseChecksumPath
	}
	$manifestPath = Join-Path $Root $Manifest
	$lines = [IO.File]::ReadAllLines($manifestPath)
	if ($lines.Count -eq 0) {
		Write-ReleaseError "Checksum manifest is empty: $manifestPath"
	}
	$entries = @(
		foreach ($line in $lines) {
			if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') {
				Write-ReleaseError "Invalid checksum entry: $line"
			}
			$path = $Matches[2]
			if ([IO.Path]::IsPathRooted($path) -or ($path -split '[/\\]') -contains '..') {
				Write-ReleaseError "Invalid release path: $path"
			}
			[pscustomobject] @{ Hash = $Matches[1].ToLowerInvariant(); Path = $path }
		}
	)
	if (@($entries.Path | Sort-Object -Unique).Count -ne $entries.Count) {
		Write-ReleaseError 'Checksum manifest must contain unique paths'
	}
	return $entries
}

function Get-ReleaseBundlePath([string] $Root) {
	return @(Read-ReleaseChecksumEntry -Root $Root | ForEach-Object Path)
}

function Get-ReleasePath([string] $Root) {
	return @((Get-ReleaseChecksumPath)) + @(Get-ReleaseBundlePath -Root $Root)
}

function Get-RootLicensePath([string] $Root) {
	return @(
		Get-ChildItem -LiteralPath $Root -File |
			Where-Object Name -Match '^LICEN[CS]E(?:$|[._-])' |
			ForEach-Object Name |
			Sort-Object
	)
}

function Get-ActionPackagePath {
	param(
		[Parameter(Mandatory)] [string] $Root,
		[string[]] $LicensePath = @()
	)
	return @('action.yml', 'README.md') + @($LicensePath) + @(Get-ReleasePath -Root $Root)
}

function Get-ActionSourcePath {
	param(
		[Parameter(Mandatory)] [string] $Root,
		[string[]] $LicensePath = @()
	)
	return @('action.yml') + @($LicensePath) + @(Get-ReleasePath -Root $Root)
}

function Get-ReleaseAssetName([string[]] $Path) {
	$names = @($Path | ForEach-Object { Split-Path -Leaf $_ })
	if (@($names | Sort-Object -Unique).Count -ne $names.Count) {
		Write-ReleaseError 'Release paths must have unique asset names'
	}
	return $names
}

function Assert-ReleaseChecksum {
	param(
		[Parameter(Mandatory)] [string] $Root,
		[string] $Manifest
	)

	foreach ($entry in @(Read-ReleaseChecksumEntry -Root $Root -Manifest $Manifest)) {
		$path = Join-Path $Root $entry.Path
		$actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
		if ($actual -ne $entry.Hash) {
			Write-ReleaseError "Checksum mismatch for $path"
		}
	}
}

function Assert-FilesIdentical([string] $Expected, [string] $Actual) {
	$expectedHash = (Get-FileHash -LiteralPath $Expected -Algorithm SHA256).Hash
	$actualHash = (Get-FileHash -LiteralPath $Actual -Algorithm SHA256).Hash
	if ($expectedHash -ne $actualHash) {
		Write-ReleaseError "Files differ: $Expected and $Actual"
	}
}

function Get-StableReleaseTag([object[]] $Releases) {
	return @(
		$Releases |
			Where-Object { -not $_.draft -and -not $_.prerelease -and $_.tag_name -match '^v\d+\.\d+\.\d+$' } |
			ForEach-Object { $_.tag_name }
	)
}

function Get-PreviousStableReleaseVersion([string[]] $Tags, [string] $Version) {
	$current = Assert-StableReleaseVersion $Version
	$previous = @(
		$Tags |
			Where-Object { $_ -match '^v\d+\.\d+\.\d+$' } |
			ForEach-Object { [pscustomobject] @{ Tag = $_; Parsed = [version] $_.Substring(1) } } |
			Where-Object { $_.Parsed -lt $current } |
			Sort-Object Parsed -Descending
	) | Select-Object -First 1
	if ($null -eq $previous) {
		return $null
	}
	return $previous.Tag
}

function Get-LatestStableReleaseVersion([string[]] $Tags, [string] $Prefix) {
	$pattern = if ($Prefix -match '^v\d+$') {
		"^$([regex]::Escape($Prefix))\.\d+\.\d+$"
	}
	elseif ($Prefix -match '^v\d+\.\d+$') {
		"^$([regex]::Escape($Prefix))\.\d+$"
	}
	else {
		Write-ReleaseError "Invalid floating release prefix: $Prefix"
	}
	$latest = @(
		$Tags |
			Where-Object { $_ -match $pattern } |
			ForEach-Object { [pscustomobject] @{ Tag = $_; Parsed = [version] $_.Substring(1) } } |
			Sort-Object Parsed -Descending
	) | Select-Object -First 1
	if ($null -eq $latest) {
		return $null
	}
	return $latest.Tag
}

function Get-SourceCommit([string] $Message, [string] $Fallback) {
	if ($Message -match '(?m)^Source-Commit:\s*([0-9a-f]{40})\s*$') {
		return $Matches[1]
	}
	return $Fallback
}

function Format-ReleaseNote {
	param(
		[Parameter(Mandatory)] [AllowEmptyCollection()] [object[]] $Commits,
		[Parameter(Mandatory)] [string] $RepositoryUrl,
		[Parameter(Mandatory)] [string] $Version,
		[Parameter(Mandatory)] [string] $SourceSha,
		[Parameter(Mandatory)] [string] $ReleaseSha,
		[Parameter(Mandatory)] [string] $AttestationUrl,
		[Parameter(Mandatory)] [string[]] $ReleasePath
	)

	$repository = ([Uri] $RepositoryUrl).AbsolutePath.Trim('/')
	$assetUrl = "$RepositoryUrl/releases/download/$Version"
	$assetNames = @(Get-ReleaseAssetName -Path $ReleasePath)
	$assetLinks = @($assetNames | ForEach-Object { "[``$_``]($assetUrl/$_)" })
	$downloadPatterns = @($assetNames | ForEach-Object { "--pattern $_" }) -join ' '
	$lines = @(
		'## Provenance and verification'
		''
		"This release contains the generated JavaScript Action bundle built from source commit [``$($SourceSha.Substring(0, 7))``]($RepositoryUrl/commit/$SourceSha) and added by signed release commit [``$($ReleaseSha.Substring(0, 7))``]($RepositoryUrl/commit/$ReleaseSha)."
		''
		"- Bundle provenance: [GitHub artifact attestation]($AttestationUrl)"
		"- Release assets: $($assetLinks -join ', ')"
		'- Independent rebuild: the generated bundles matched a clean rebuild from the source commit byte-for-byte before the draft was created'
		'- Finalization: publication verifies the immutable release, assets, checksums, provenance, and release commit before moving floating tags'
		''
		'Verify the published release and its downloaded assets with GitHub CLI:'
		''
		'```sh'
		"gh release verify $Version -R $repository"
		"gh release download $Version -R $repository $downloadPatterns"
	)
	$lines += @(
		$assetNames | ForEach-Object { "gh release verify-asset $Version $_ -R $repository" }
	)
	$lines += '```'
	if ($Commits.Count -eq 0) {
		return ($lines -join "`n") + "`n`n"
	}
	$lines += @('', '## Source changes', '')
	foreach ($commit in $Commits) {
		$subject = ([string] $commit.commit.message -split "`r?`n", 2)[0]
		$shortSha = ([string] $commit.sha).Substring(0, 7)
		$lines += "- [``$shortSha``]($RepositoryUrl/commit/$($commit.sha)): $subject"
	}
	return ($lines -join "`n") + "`n`n"
}

function Format-ReleaseReadme {
	param(
		[Parameter(Mandatory)] [string] $RepositoryUrl,
		[Parameter(Mandatory)] [string] $Version,
		[Parameter(Mandatory)] [string] $SourceSha,
		[Parameter(Mandatory)] [string] $AttestationUrl,
		[string[]] $LicensePath = @()
	)

	$repository = ([Uri] $RepositoryUrl).AbsolutePath.Trim('/')
	$shortSourceSha = $SourceSha.Substring(0, 7)
	$lines = @"
# dprint/check $Version

This is the generated JavaScript Action package for [$Version]($RepositoryUrl/releases/tag/$Version). It was built from source commit [``$shortSourceSha``]($RepositoryUrl/commit/$SourceSha).

## Usage

~~~yaml
- uses: $repository@$Version
~~~

## Provenance

- Bundle attestation: [view on GitHub]($AttestationUrl)
- Checksum manifest: [``SHA256SUMS``]($RepositoryUrl/blob/$Version/SHA256SUMS)
- Immutable release: [$Version]($RepositoryUrl/releases/tag/$Version)
"@
	foreach ($path in $LicensePath) {
		$lines += "`n- License: [``$path``]($RepositoryUrl/blob/$Version/$path)"
	}
	$lines += @"

## Verify

~~~sh
gh release verify $Version -R $repository
gh attestation verify dist/main.mjs --repo $repository --source-digest $SourceSha
gh attestation verify dist/post.mjs --repo $repository --source-digest $SourceSha
~~~
"@
	return $lines
}

function Get-ReleaseBadgeUrl {
	param(
		[Parameter(Mandatory)] [string] $Repository,
		[Parameter(Mandatory)] [string] $Version
	)
	return "https://img.shields.io/github/v/release/${Repository}?include_prereleases&sort=semver&filter=${Version}&display_name=release&style=flat-square"
}

function Get-TagBadgeUrl {
	param(
		[Parameter(Mandatory)] [string] $Repository,
		[Parameter(Mandatory)] [string] $Version
	)
	return "https://img.shields.io/github/v/tag/${Repository}?include_prereleases&sort=semver&filter=${Version}&label=tree&style=flat-square"
}

function Update-ReleaseBadgeCache {
	param(
		[Parameter(Mandatory)] [string] $Repository,
		[Parameter(Mandatory)] [string] $Version
	)

	$outputPath = Join-Path (Get-RequiredEnvironmentVariable 'RUNNER_TEMP') 'release-badge.svg'
	foreach ($url in @(
			Get-ReleaseBadgeUrl -Repository $Repository -Version $Version
			Get-TagBadgeUrl -Repository $Repository -Version $Version
		)) {
		try {
			& curl --fail --silent --show-error --header 'Cache-Control: no-cache' --header 'Pragma: no-cache' --output $outputPath $url
		}
		catch {
			Write-Warning "Could not refresh badge cache: $url"
		}
	}
}

function Invoke-GitBlobCreation([string] $Path) {
	$content = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Path)))
	return (Invoke-GitHubApi -Method POST -Path 'repos/{owner}/{repo}/git/blobs' -Body @{
			content  = $content
			encoding = 'base64'
		}).sha
}

function Get-ReleaseHistory {
	$pages = Invoke-GitHubApi -Path 'repos/{owner}/{repo}/releases?per_page=100' -Paginate
	return @($pages | ForEach-Object { $_ })
}

function Assert-ReleaseDoesNotExist([string] $Version) {
	$existing = @(Get-ReleaseHistory | Where-Object { $_.tag_name -eq $Version })
	if ($existing.Count -eq 0) {
		return
	}
	$locations = @($existing | ForEach-Object html_url) -join ', '
	Write-ReleaseError "Release $Version already exists: $locations"
}

function Wait-ReleaseByUrl {
	param(
		[Parameter(Mandatory)] [string] $Url,
		[int] $Attempts = 5,
		[int] $DelaySeconds = 2
	)

	foreach ($attempt in 1..$Attempts) {
		$releases = @(Get-ReleaseHistory | Where-Object { $_.html_url -eq $Url })
		if ($releases.Count -gt 1) {
			Write-ReleaseError "Multiple releases have URL: $Url"
		}
		if ($releases.Count -eq 1) {
			return $releases[0]
		}
		if ($attempt -lt $Attempts) {
			Start-Sleep -Seconds $DelaySeconds
		}
	}
	return $null
}

function Update-FloatingTag {
	[CmdletBinding(SupportsShouldProcess)]
	param(
		[Parameter(Mandatory)] [string] $Tag,
		[Parameter(Mandatory)] [string] $Sha
	)
	if (-not $PSCmdlet.ShouldProcess("refs/tags/$Tag", "Move to $Sha")) {
		return
	}
	$refPath = "repos/{owner}/{repo}/git/ref/tags/$Tag"
	if (Test-NativeCommand { gh api $refPath }) {
		$null = Invoke-GitHubApi -Method PATCH -Path "repos/{owner}/{repo}/git/refs/tags/$Tag" -Body @{
			sha   = $Sha
			force = $true
		}
	}
	else {
		$null = Invoke-GitHubApi -Method POST -Path 'repos/{owner}/{repo}/git/refs' -Body @{
			ref = "refs/tags/$Tag"
			sha = $Sha
		}
	}
	$actual = (Invoke-GitHubApi -Path $refPath).object.sha
	if ($actual -ne $Sha) {
		Write-ReleaseError "$Tag points to $actual, expected $Sha"
	}
}
