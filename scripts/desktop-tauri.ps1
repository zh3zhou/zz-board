[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('build', 'dev')]
  [string]$Mode
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$defaultTarget = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'src-tauri\target'))
$targetRoot = if ($env:CARGO_TARGET_DIR) { [System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) } else { $defaultTarget }
# A machine-wide Cargo cache must not silently relocate this E-drive application.
if ($targetRoot -ne $defaultTarget -and -not $targetRoot.StartsWith($defaultTarget.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  $targetRoot = $defaultTarget
}
$env:CARGO_TARGET_DIR = $targetRoot
$releasePrefix = (Join-Path $targetRoot 'release').TrimEnd('\') + '\'
$debugPrefix = (Join-Path $targetRoot 'debug').TrimEnd('\') + '\'
# Tauri may copy web files before encountering a locked node.exe: fail before
# beforeBuildCommand to reject an already-running target before copying resources.
$locked = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and ($_.ExecutablePath.StartsWith($releasePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or $_.ExecutablePath.StartsWith($debugPrefix, [System.StringComparison]::OrdinalIgnoreCase))
})
if ($locked.Count -gt 0) {
  throw 'Desktop target is in use. Truly exit the target tray app, or choose a separate CARGO_TARGET_DIR before building. No runtime resources were changed.'
}
$pnpm = Get-Command pnpm.cmd -ErrorAction Stop

Push-Location -LiteralPath $projectRoot
try {
  # Tauri copies resources over an existing target without pruning old hashes.
  # Replace this checked, generated runtime before rebuilding either profile.
  $profile = if ($Mode -eq 'build') { 'release' } else { 'debug' }
  & node (Join-Path $PSScriptRoot 'desktop-runtime.ts') clean-target $projectRoot $targetRoot $profile
  if ($LASTEXITCODE -ne 0) { throw 'Desktop target preparation failed; Tauri was not started.' }
  & $pnpm.Source exec tauri $Mode
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri $Mode failed with exit code $LASTEXITCODE."
  }
}
finally {
  Pop-Location
}
