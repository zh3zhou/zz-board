[CmdletBinding()]
param(
  [string]$NodePath = '',
  [ValidateRange(1, 65535)]
  [int]$Port = 4318,
  [string]$DataDir = '',
  [ValidateRange(1, 120)]
  [int]$TimeoutSeconds = 20,
  [switch]$NoBrowser,
  [switch]$Plan
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runnerPath = Join-Path $PSScriptRoot 'run-server.ps1'
$healthUri = "http://127.0.0.1:$Port/api/health"
$boardUri = "http://127.0.0.1:$Port/"
$defaultDataDir = Join-Path $projectRoot '.local-data'
$effectiveDataDir = if ($DataDir) { [System.IO.Path]::GetFullPath($DataDir) } else { $defaultDataDir }
$logPath = Join-Path $effectiveDataDir 'logs\server.log'

function Test-ZzBoardHealth {
  try {
    $response = Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 2
    return ($null -ne $response -and $response.ok -eq $true)
  }
  catch {
    return $false
  }
}

function ConvertTo-QuotedArgument([string]$Value) {
  if ($Value.Contains('"')) { throw 'A command path cannot contain a double quote.' }
  return '"' + $Value + '"'
}

if ($Plan) {
  [pscustomobject]@{
    Mode = 'plan-only'
    HealthCheck = $healthUri
    WhenUnavailable = "Start hidden runner: $runnerPath"
    DataDirectory = $effectiveDataDir
    Log = $logPath
    Browser = if ($NoBrowser) { 'do not open' } else { $boardUri }
  }
  return
}

if (-not (Test-ZzBoardHealth)) {
  $powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
  $runnerArguments = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', (ConvertTo-QuotedArgument $runnerPath),
    '-Port', [string]$Port,
    '-DataDir', (ConvertTo-QuotedArgument $effectiveDataDir)
  )
  if ($NodePath) {
    $resolvedNode = (Resolve-Path -LiteralPath $NodePath).Path
    $runnerArguments += @('-NodePath', (ConvertTo-QuotedArgument $resolvedNode))
  }

  Start-Process -FilePath $powerShellPath -ArgumentList ($runnerArguments -join ' ') -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null

  $deadline = [DateTimeOffset]::Now.AddSeconds($TimeoutSeconds)
  while ([DateTimeOffset]::Now -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (Test-ZzBoardHealth) { break }
  }
  if (-not (Test-ZzBoardHealth)) {
    throw "ZZ Board did not become ready within $TimeoutSeconds seconds. Check $logPath"
  }
}

if (-not $NoBrowser) {
  Start-Process -FilePath $boardUri | Out-Null
}
Write-Host "ZZ Board is ready at $boardUri"

