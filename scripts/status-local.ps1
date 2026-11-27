[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 4318
)

$ErrorActionPreference = 'Stop'

$taskName = 'ZZ Board Local Service'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$dataDir = Join-Path $projectRoot '.local-data'
$healthUri = "http://127.0.0.1:$Port/api/health"
$health = $null
$healthError = $null

try {
  $health = Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 2
}
catch {
  $healthError = $_.Exception.Message
}

$scheduledTask = $null
$scheduledTaskInfo = $null
$taskQueryError = $null
try {
  $scheduledTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($scheduledTask) {
    $scheduledTaskInfo = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
  }
}
catch {
  $taskQueryError = $_.Exception.Message
}

$legacyShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'ZZ Board.lnk'
[pscustomobject]@{
  Service = if ($health -and $health.ok -eq $true) { 'available' } else { 'unavailable' }
  Url = "http://127.0.0.1:$Port/"
  Health = $health
  HealthError = $healthError
  ScheduledTaskInstalled = [bool]$scheduledTask
  ScheduledTaskState = if ($scheduledTask) { [string]$scheduledTask.State } else { $null }
  LastTaskRun = if ($scheduledTaskInfo) { $scheduledTaskInfo.LastRunTime } else { $null }
  LastTaskResult = if ($scheduledTaskInfo) { $scheduledTaskInfo.LastTaskResult } else { $null }
  TaskQueryError = $taskQueryError
  LegacyStartupShortcut = Test-Path -LiteralPath $legacyShortcut -PathType Leaf
  DataDirectory = $dataDir
  Log = Join-Path $dataDir 'logs\server.log'
}

