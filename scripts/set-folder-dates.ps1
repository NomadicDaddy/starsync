param(
	[string]$RootPath,
	[switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

function Get-EnvTargetPath {
	$envFile = Join-Path $PSScriptRoot '..\.env'
	if (-not (Test-Path -LiteralPath $envFile)) {
		return $null
	}
	$line = Get-Content -LiteralPath $envFile |
		Where-Object { $_ -match '^\s*TARGET_PATH\s*=' } |
		Select-Object -First 1
	if (-not $line) {
		return $null
	}
	return ($line -replace '^\s*TARGET_PATH\s*=\s*', '').Trim().Trim('"').Trim("'")
}

if ([string]::IsNullOrWhiteSpace($RootPath)) {
	$RootPath = Get-EnvTargetPath
}

if ([string]::IsNullOrWhiteSpace($RootPath)) {
	$RootPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path 'starred_repos'
}

$root = Resolve-Path -LiteralPath $RootPath
$results = [System.Collections.Generic.List[object]]::new()

Get-ChildItem -LiteralPath $root.Path -Directory -Force | ForEach-Object {
	$repoPath = $_.FullName
	$gitPath = Join-Path $repoPath '.git'
	if (-not (Test-Path -LiteralPath $gitPath)) {
		$results.Add([pscustomobject]@{
				Name    = $_.Name
				Status  = 'skipped:not-git'
				OldTime = $_.LastWriteTime
				NewTime = $_.LastWriteTime
			})
		return
	}
	$iso = & git -C $repoPath log -1 --format=%cI 2>$null
	if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($iso)) {
		$results.Add([pscustomobject]@{
				Name    = $_.Name
				Status  = 'skipped:no-commit'
				OldTime = $_.LastWriteTime
				NewTime = $_.LastWriteTime
			})
		return
	}
	$commitTime = [datetimeoffset]::Parse($iso).LocalDateTime
	$oldTime = $_.LastWriteTime
	if (-not $WhatIf) {
		$_.LastWriteTime = $commitTime
	}
	$results.Add([pscustomobject]@{
			Name    = $_.Name
			Status  = if ($WhatIf) { 'would-update' } else { 'updated' }
			OldTime = $oldTime
			NewTime = $commitTime
		})
}

$changed = @($results | Where-Object { $_.Status -in @('updated', 'would-update') })
$skipped = @($results | Where-Object { $_.Status -notin @('updated', 'would-update') })
$changedLabel = if ($WhatIf) { 'Would update' } else { 'Updated' }

Write-Host "Root: $($root.Path)"
Write-Host "${changedLabel}: $($changed.Count)"
Write-Host "Skipped: $($skipped.Count)"

if ($changed.Count -gt 0) {
	Write-Host ''
	Write-Host 'Oldest folder timestamps:'
	$changed | Sort-Object NewTime | Select-Object -First 10 Name, NewTime, OldTime | Format-Table -AutoSize
	Write-Host 'Newest folder timestamps:'
	$changed | Sort-Object NewTime -Descending | Select-Object -First 10 Name, NewTime, OldTime | Format-Table -AutoSize
}

if ($skipped.Count -gt 0) {
	Write-Host 'Skipped folders:'
	$skipped | Select-Object Name, Status | Format-Table -AutoSize
}
