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

function Invoke-GitHubApi {
	param(
		[Parameter(Mandatory)] [string] $Path,
		[ValidateSet('GET', 'POST', 'PATCH', 'PUT', 'DELETE')] [string] $Method = 'GET',
		[object] $Body,
		[switch] $Paginate
	)

	$apiVersion = Get-RequiredEnvironmentVariable 'GH_API_VERSION'
	$arguments = @('api', '-H', "X-GitHub-Api-Version: $apiVersion")
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


function Write-ReleaseChecksum {
	[CmdletBinding(SupportsShouldProcess)]
	param(
		[Parameter(Mandatory)] [string] $Root,
		[Parameter(Mandatory)] [string[]] $Paths,
		[string] $Manifest = 'SHA256SUMS'
	)

	$manifestPath = Join-Path $Root $Manifest
	if (-not $PSCmdlet.ShouldProcess($manifestPath, 'Write release checksum manifest')) {
		return
	}
	$lines = foreach ($path in $Paths) {
		$fullPath = Join-Path $Root $path
		if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
			Write-ReleaseError "Missing release file: $fullPath"
		}
		$hash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
		"$hash  $path"
	}
	[IO.File]::WriteAllText($manifestPath, ($lines -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
}

function Assert-ReleaseChecksum {
	param(
		[Parameter(Mandatory)] [string] $Root,
		[string] $Manifest = 'SHA256SUMS'
	)

	$manifestPath = Join-Path $Root $Manifest
	$lines = [IO.File]::ReadAllLines($manifestPath)
	if ($lines.Count -eq 0) {
		Write-ReleaseError "Checksum manifest is empty: $manifestPath"
	}
	foreach ($line in $lines) {
		if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') {
			Write-ReleaseError "Invalid checksum entry: $line"
		}
		$expected = $Matches[1].ToLowerInvariant()
		$path = Join-Path $Root $Matches[2]
		$actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
		if ($actual -ne $expected) {
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

function Format-ReleaseNote([object[]] $Commits, [string] $RepositoryUrl) {
	if ($Commits.Count -eq 0) {
		return $null
	}
	$lines = @('## Changes', '')
	foreach ($commit in $Commits) {
		$subject = ([string] $commit.commit.message -split "`r?`n", 2)[0]
		$shortSha = ([string] $commit.sha).Substring(0, 7)
		$lines += "- [``$shortSha``]($RepositoryUrl/commit/$($commit.sha)): $subject"
	}
	return ($lines -join "`n") + "`n`n"
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
	if (Test-NativeCommand { gh api -H "X-GitHub-Api-Version: $env:GH_API_VERSION" $refPath }) {
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
