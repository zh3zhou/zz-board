[CmdletBinding()]
param(
  [string]$NodePath = '',
  [ValidateRange(1, 65535)]
  [int]$Port = 4318,
  [string]$DataDir = '',
  [switch]$Plan
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$serverEntrypoint = Join-Path $projectRoot 'dist\server\index.js'
if (-not $NodePath) {
  $nodeCommand = Get-Command node.exe -ErrorAction Stop
  $NodePath = $nodeCommand.Source
}
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path

if (-not $DataDir) {
  $DataDir = Join-Path $projectRoot '.local-data'
}
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
$logDirectory = Join-Path $DataDir 'logs'
$logPath = Join-Path $logDirectory 'server.log'
$previousLogPath = Join-Path $logDirectory 'server.previous.log'

if ($Plan) {
  [pscustomobject]@{
    Mode = 'plan-only'
    Node = $NodePath
    Entrypoint = $serverEntrypoint
    Listen = "http://127.0.0.1:$Port"
    DataDirectory = $DataDir
    Log = $logPath
  }
  return
}

if (-not (Test-Path -LiteralPath $serverEntrypoint -PathType Leaf)) {
  throw "The production server is not built. Run 'pnpm build' in $projectRoot first."
}

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
if ((Test-Path -LiteralPath $logPath -PathType Leaf) -and (Get-Item -LiteralPath $logPath).Length -gt 10MB) {
  Move-Item -LiteralPath $logPath -Destination $previousLogPath -Force
}

$previousHost = $env:ZZ_BOARD_HOST
$previousPort = $env:ZZ_BOARD_PORT
$previousDataDir = $env:ZZ_BOARD_DATA_DIR
$nodeExitCode = 0

try {
  $env:ZZ_BOARD_HOST = '127.0.0.1'
  $env:ZZ_BOARD_PORT = [string]$Port
  $env:ZZ_BOARD_DATA_DIR = $DataDir
  Push-Location -LiteralPath $projectRoot
  try {
    "[$([DateTimeOffset]::Now.ToString('o'))] Starting ZZ Board on http://127.0.0.1:$Port" |
      Tee-Object -FilePath $logPath -Append
    & $NodePath $serverEntrypoint 2>&1 | Tee-Object -FilePath $logPath -Append
    $nodeExitCode = $LASTEXITCODE
  }
  finally {
    Pop-Location
  }
}
finally {
  $env:ZZ_BOARD_HOST = $previousHost
  $env:ZZ_BOARD_PORT = $previousPort
  $env:ZZ_BOARD_DATA_DIR = $previousDataDir
}

if ($nodeExitCode -ne 0) {
  throw "ZZ Board stopped with exit code $nodeExitCode. See $logPath"
}

