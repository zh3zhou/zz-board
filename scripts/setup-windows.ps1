[CmdletBinding()]
param(
  [switch]$Preflight,
  [switch]$Json,
  [switch]$Trial,
  [switch]$Build,
  [switch]$Deploy,
  [switch]$Start,
  [switch]$Status,
  [switch]$Rollback,
  [switch]$BindCodex,
  [string]$FromBuild,
  [string]$InstallDir
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'windows-preflight.ps1')
$hasAction = $Build -or $Deploy -or $Start -or $Status -or $Rollback -or $BindCodex -or $FromBuild
if ($Preflight -and $hasAction) { throw 'Use -Preflight separately.' }
if ($Json -and $hasAction) { throw 'Use -Json with preflight only.' }
if ($Trial -and $hasAction -and -not $Build) { throw 'Use -Trial with -Preflight or -Build. Deployment reads the build mode from its receipt.' }
if ($Status -and ($Build -or $Deploy -or $Start -or $Rollback -or $BindCodex -or $FromBuild)) { throw 'Use -Status separately.' }
if ($BindCodex -and ($Build -or $Deploy -or $Start -or $Rollback -or $FromBuild)) { throw 'Use -BindCodex separately after starting the matching source build.' }
if ($Rollback -and ($Build -or $Deploy -or $Start -or $FromBuild)) { throw 'Use -Rollback separately. Inspect the result before starting.' }
if ($FromBuild -and (-not $Deploy -or $Build)) { throw 'Use -FromBuild with -Deploy and an existing inspected build.' }
if ($Deploy -and -not ($FromBuild -or $Build)) { throw '-Deploy requires either -Build or -FromBuild <release directory>.' }
if ($Start -and $Build -and -not $Deploy) { throw 'To start the newly built app use -Build -Deploy -Start.' }
if ($InstallDir -and $hasAction -and -not ($Deploy -or $Start -or $Status -or $Rollback -or $BindCodex)) { throw '-InstallDir requires a preflight, deployment, start, status, rollback or binding action.' }

function Write-TrialSetupEvent([string]$Event, [string]$Outcome, [long]$Started = -1, [string]$Code = '') {
  if (-not $Trial) { return }
  try {
    $file = Join-Path $projectRoot '.tmp/zz-board-trial/setup.jsonl'
    $null = Get-ZzPathEntry $file
    $null = [IO.Directory]::CreateDirectory((Split-Path -Parent $file))
    $null = Get-ZzPathEntry $file
    $utc = [DateTime]::UtcNow
    $record = [ordered]@{ schemaVersion = 1; at = $utc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture); layer = 'setup'; event = $Event; outcome = $Outcome }
    if ($Started -ge 0) {
      $elapsed = ([Diagnostics.Stopwatch]::GetTimestamp() - $Started) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
      $record.elapsedMs = [long][Math]::Min(1000000000.0, [Math]::Max(0.0, $elapsed))
    }
    if ($Code) { $record.code = $Code }
    [IO.File]::AppendAllText($file, (ConvertTo-Json -Compress -InputObject $record) + "`n", (New-Object Text.UTF8Encoding($false)))
  } catch { Write-Warning 'Could not append trial setup diagnostics. Check .tmp/zz-board-trial write access.' }
}

if (-not $hasAction) {
  $report = Get-ZzPreflight $projectRoot $InstallDir ([bool]$Trial)
  if ($Json) { $report | ConvertTo-Json -Depth 6 }
  else { $report }
  return
}
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
  throw 'ZZ Board desktop source builds require Windows x64.'
}
$helper = Join-Path $PSScriptRoot 'source-deployment.mjs'
function Invoke-Deployment([string[]]$items) {
  & $node.Path $helper @items
  if ($LASTEXITCODE -ne 0) { throw ('Desktop operation failed at ' + $items[0] + '. Check the preceding diagnostic.') }
}
function Invoke-SelectedAction([string]$action, [string]$source = '') {
  $items = @($action)
  if ($source) { $items += $source }
  if ($InstallDir) { $items += $InstallDir }
  Invoke-Deployment $items
}
if (-not $Build) {
  $node = Get-ZzCommand @('node.exe')
  if (!$node) { throw 'Install Node.js 24.18.0 or newer for Windows x64.' }
  if ($Status) { Invoke-SelectedAction 'status'; return }
  if ($BindCodex) { Invoke-SelectedAction 'bind-codex'; return }
  if ($Rollback) { Invoke-SelectedAction 'rollback'; return }
  if ($FromBuild) {
    Invoke-SelectedAction 'deploy' (Resolve-Path -LiteralPath $FromBuild).Path
    if ($Start) { Invoke-SelectedAction 'start' }
    return
  }
  Invoke-SelectedAction 'start'
  return
}

$stageStarted = [Diagnostics.Stopwatch]::GetTimestamp()
Write-TrialSetupEvent 'preflight' 'start'
try {
  $report = Get-ZzPreflight $projectRoot $InstallDir ([bool]$Trial)
} catch {
  Write-TrialSetupEvent 'preflight' 'failed' $stageStarted 'prerequisite_missing'
  throw
}
$report
if (-not $report.buildReady -or ($Trial -and $Deploy -and -not $report.ready)) {
  $code = 'prerequisite_missing'
  if ($report.buildReady) {
    $firstBlocker = $report.blockers[0].code
    if ($firstBlocker -in @('existing_installation', 'port_conflict')) { $code = $firstBlocker }
  }
  Write-TrialSetupEvent 'preflight' 'blocked' $stageStarted $code
  throw ('Preflight blocked this action. ' + (($report.blockers | ForEach-Object detail) -join ' '))
}
Write-TrialSetupEvent 'preflight' 'ok' $stageStarted

$node = Get-ZzCommand @('node.exe')
$pnpm = Get-ZzCommand @('pnpm.cmd')
$previousTarget = $env:CARGO_TARGET_DIR
$previousTrial = $env:ZZ_BOARD_BUILD_TRIAL
$target = Join-Path $projectRoot ('src-tauri\target\setup-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))
$buildMode = if ($Trial) { 'trial' } else { 'standard' }
Push-Location -LiteralPath $projectRoot
try {
  $stageStarted = [Diagnostics.Stopwatch]::GetTimestamp()
  Write-TrialSetupEvent 'build' 'start'
  try {
    if (Test-Path -LiteralPath $target) { throw 'The isolated build target already exists.' }
    $env:CARGO_TARGET_DIR = $target
    $env:ZZ_BOARD_BUILD_TRIAL = '0'
    $sourceBefore = (Invoke-Deployment @('fingerprint')) | ConvertFrom-Json
    foreach ($step in @(
      @('install', '--frozen-lockfile'),
      @('check'),
      @('smoke:windows'),
      @('desktop:build')
    )) {
      # Only the candidate packaging step receives the trial marker.
      if ($step[0] -eq 'desktop:build' -and $Trial) { $env:ZZ_BOARD_BUILD_TRIAL = '1' }
      Write-Host ('Running pnpm ' + ($step -join ' '))
      & $pnpm.Path @step
      if ($LASTEXITCODE -ne 0) { throw ('Stopped at pnpm ' + ($step -join ' ') + '; earlier outputs are retained.') }
    }
    Write-TrialSetupEvent 'build' 'ok' $stageStarted
  } catch {
    Write-TrialSetupEvent 'build' 'failed' $stageStarted 'build_failed'
    throw
  }

  $stageStarted = [Diagnostics.Stopwatch]::GetTimestamp()
  Write-TrialSetupEvent 'verify' 'start'
  try {
    $executable = Join-Path $target 'release\zz-board.exe'
    & (Join-Path $PSScriptRoot 'desktop-smoke.ps1') -Executable $executable
    $release = Split-Path -Parent $executable
    $receipt = Invoke-Deployment @('receipt', $release, $sourceBefore.buildInputsSha256, $buildMode)
    Write-TrialSetupEvent 'verify' 'ok' $stageStarted
  } catch {
    Write-TrialSetupEvent 'verify' 'failed' $stageStarted 'verify_failed'
    throw
  }
  [pscustomobject]@{ Mode = 'built-and-inspected'; Trial = [bool]$Trial; Executable = $executable; Resources = (Join-Path $target 'release\resources'); SourceReceipt = $receipt; Activated = $false; Published = $false }
  if ($Deploy) {
    Invoke-SelectedAction 'deploy' $release
    if ($Start) { Invoke-SelectedAction 'start' }
  }
}
finally {
  $env:CARGO_TARGET_DIR = $previousTarget
  $env:ZZ_BOARD_BUILD_TRIAL = $previousTrial
  Pop-Location
}
