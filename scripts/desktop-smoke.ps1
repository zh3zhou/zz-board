[CmdletBinding()]
param(
  [string]$Executable = '',
  [ValidateRange(1, 120)]
  [int]$StartupTimeoutSeconds = 30,
  [switch]$Launch
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$configPath = Join-Path $projectRoot 'src-tauri\tauri.conf.json'
if (-not $Executable) { $Executable = Join-Path $projectRoot 'src-tauri\target\release\zz-board.exe' }
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Desktop executable not found: $Executable" }
# Inspect the resource slot the exact executable will select (raw build,
# NSIS install or a fixed-path portable install).
$runtimeDir = & node (Join-Path $PSScriptRoot 'install-portable.mjs') --runtime-for $Executable
if ($LASTEXITCODE -ne 0 -or -not $runtimeDir) { throw 'Could not locate a matching desktop runtime.' }
$healthUri = 'http://127.0.0.1:4318/api/health'

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
if ($config.version -ne $package.version) {
  throw "Unexpected Tauri version: $($config.version)"
}
$binaryVersion = (Get-Item -LiteralPath $Executable).VersionInfo.ProductVersion
if ($binaryVersion -ne $package.version) { throw "Executable version $binaryVersion does not match source version $($package.version)." }

$resources = @('node.exe', 'server.cjs', 'manifest.json', 'dist\web\index.html', 'node_modules\sharp\package.json')
$missing = @($resources | Where-Object { -not (Test-Path -LiteralPath (Join-Path $runtimeDir $_) -PathType Leaf) })
if ($missing.Count -gt 0) {
  throw "Desktop runtime resources are missing: $($missing -join ', '). Run the desktop sidecar build first."
}
$manifest = Get-Content -LiteralPath (Join-Path $runtimeDir 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.appVersion -ne $binaryVersion) { throw 'Packaged runtime and executable versions differ.' }
& (Join-Path $runtimeDir 'node.exe') (Join-Path $PSScriptRoot 'desktop-runtime.ts') verify $runtimeDir $binaryVersion
if ($LASTEXITCODE -ne 0) { throw 'Packaged runtime integrity failed: missing, changed, or stale files.' }
$decoderProbe = & (Join-Path $runtimeDir 'node.exe') -e "const s = require(process.argv[1]); s({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer().then(b=>{if(b.length<30)process.exit(2);console.log('image-decoder-ok')}).catch(()=>process.exit(3));" (Join-Path $runtimeDir 'node_modules\sharp')
if ($LASTEXITCODE -ne 0 -or $decoderProbe -ne 'image-decoder-ok') { throw 'Packaged native image decoder failed.' }
$webRoot = Join-Path $runtimeDir 'dist\web'
$entry = Get-Content -LiteralPath (Join-Path $webRoot 'index.html') -Raw
foreach ($asset in [regex]::Matches($entry, '(?:src|href)="(/assets/[^\"]+)"')) {
  if (-not (Test-Path -LiteralPath (Join-Path $webRoot $asset.Groups[1].Value.TrimStart('/')) -PathType Leaf)) {
    throw "Packaged entry asset is missing: $($asset.Groups[1].Value)"
  }
}

if (-not $Launch) {
  [pscustomobject]@{
    Mode = 'inspection-only'
    Executable = $Executable
    ExecutableExists = Test-Path -LiteralPath $Executable -PathType Leaf
    RuntimeResources = $resources.Count
    Version = $binaryVersion
    RuntimeVersion = $manifest.appVersion
    Url = 'http://127.0.0.1:4318/'
  }
  return
}

$before = @(Get-Process -Name 'zz-board' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
Start-Process -FilePath $Executable -ArgumentList '--background' -WindowStyle Hidden
$deadline = [DateTimeOffset]::Now.AddSeconds($StartupTimeoutSeconds)
$health = $null
do {
  try {
    $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 2
  }
  catch {
    Start-Sleep -Milliseconds 250
  }
} while (-not $health -and [DateTimeOffset]::Now -lt $deadline)

if (-not $health) {
  throw "ZZ Board desktop runtime did not become healthy within $StartupTimeoutSeconds seconds."
}
if ($health.ok -ne $true -or $health.appVersion -ne $config.version -or -not $health.dataStoreId) {
  throw 'ZZ Board returned an incompatible health response.'
}

$after = @(Get-Process -Name 'zz-board' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
[pscustomobject]@{
  Mode = 'launched'
  Healthy = $true
  AppVersion = $health.appVersion
  Runtime = $health.runtime
  DataStoreIdPresent = [bool]$health.dataStoreId
  NewDesktopProcessIds = @($after | Where-Object { $_ -notin $before })
  Note = 'This smoke check leaves the tray application running; use the tray action to exit it.'
}
