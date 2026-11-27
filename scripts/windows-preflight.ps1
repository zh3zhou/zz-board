# A PowerShell-only entry keeps diagnostics available before Node is installed.
function Get-ZzCommand([string[]]$Names) {
  return Get-Command -Name $Names -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Invoke-ZzProbe([string]$Executable, [string[]]$Arguments) {
  if (!$Executable) { return $null }
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Executable @Arguments 2>$null
    if ($LASTEXITCODE -eq 0) { return ($output -join "`n").Trim() }
  } catch { return $null }
  return $null
}

function Get-ZzVersionPrefix([string]$Text) {
  if ($Text -match '(?:^|\s)v?(\d+\.\d+\.\d+)(?:$|\s)') { return $Matches[1] }
  return $null
}

function Get-ZzPackageVersion([string]$Path) {
  try {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      return (Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json).version
    }
  } catch { return $null }
  return $null
}

function Get-ZzPnpmVersion($Command, [string]$Required, [string]$LocalAppData) {
  if (!$Command) { return $null }
  if ($Command.Path.EndsWith('.cmd', [StringComparison]::OrdinalIgnoreCase)) {
    $directory = Split-Path -Parent $Command.Path
    $shim = (Get-Content -LiteralPath $Command.Path -TotalCount 30 -ErrorAction SilentlyContinue) -join "`n"
    if ($shim -match 'node_modules[\\/]corepack[\\/]') {
      # A Corepack --version can bootstrap pnpm. Inspect its pinned cache without
      # invoking the shim or contacting a registry.
      $cache = $env:COREPACK_HOME
      if (!$cache -and $LocalAppData) { $cache = Join-Path $LocalAppData 'node/corepack' }
      if (!$cache) { return $null }
      $package = Join-Path $cache ('v1/pnpm/' + $Required + '/package.json')
      return Get-ZzPackageVersion $package
    }
    $package = Join-Path $directory 'node_modules/pnpm/package.json'
    if (Test-Path -LiteralPath $package -PathType Leaf) {
      return Get-ZzPackageVersion $package
    }
  }
  return Get-ZzVersionPrefix (Invoke-ZzProbe $Command.Path @('--version'))
}

function Get-ZzRustTools($Rust, $Cargo) {
  $rustPath = $Rust.Path
  $cargoPath = $Cargo.Path
  $rustup = Get-ZzCommand @('rustup.exe')
  if ($rustup) {
    # rustup which reports an installed executable. Prevent implicit toolchain
    # installation when the selected channel is configured but absent.
    $priorAutoInstall = [Environment]::GetEnvironmentVariable('RUSTUP_AUTO_INSTALL', 'Process')
    [Environment]::SetEnvironmentVariable('RUSTUP_AUTO_INSTALL', '0', 'Process')
    try {
      if ($rustPath -and (Split-Path -Parent $rustPath) -eq (Split-Path -Parent $rustup.Path)) {
        $rustPath = Invoke-ZzProbe $rustup.Path @('which', 'rustc')
      }
      if ($cargoPath -and (Split-Path -Parent $cargoPath) -eq (Split-Path -Parent $rustup.Path)) {
        $cargoPath = Invoke-ZzProbe $rustup.Path @('which', 'cargo')
      }
    } finally { [Environment]::SetEnvironmentVariable('RUSTUP_AUTO_INSTALL', $priorAutoInstall, 'Process') }
  }
  $info = Invoke-ZzProbe $rustPath @('-vV')
  $hostTriple = if ($info -match '(?m)^host:\s+([^\r\n]+)') { $Matches[1] } else { $null }
  return [pscustomobject]@{ Rust = (Get-ZzVersionPrefix $info); Cargo = (Get-ZzVersionPrefix (Invoke-ZzProbe $cargoPath @('--version'))); Host = $hostTriple }
}

function Get-ZzMsvcVersion {
  $vsRoot = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($vsRoot) {
    $vswhere = Join-Path $vsRoot 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
      $candidates = Invoke-ZzProbe $vswhere @('-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath')
      foreach ($candidate in ($candidates -split '\r?\n')) {
        if (!$candidate) { continue }
        $tools = Join-Path $candidate 'VC/Tools/MSVC'
        $ready = Get-ChildItem -LiteralPath $tools -Directory -ErrorAction SilentlyContinue | Where-Object {
          Test-Path -LiteralPath (Join-Path $_.FullName 'bin/Hostx64/x64/cl.exe') -PathType Leaf
        } | Select-Object -First 1
        if ($ready) { return $ready.Name }
      }
    }
  }
  $compiler = Get-ZzCommand @('cl.exe')
  if ($compiler.Path -match '[\\/]bin[\\/]Host(?:x64|x86)[\\/]x64[\\/]cl\.exe$') { return (Get-Item -LiteralPath $compiler.Path).VersionInfo.FileVersion }
  return $null
}

function Get-ZzWebViewVersion {
  $clientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  foreach ($hive in @('HKLM:\SOFTWARE', 'HKLM:\SOFTWARE\WOW6432Node', 'HKCU:\SOFTWARE', 'HKCU:\SOFTWARE\WOW6432Node')) {
    $item = Get-ItemProperty -LiteralPath "$hive\Microsoft\EdgeUpdate\Clients\$clientId" -Name 'pv' -ErrorAction SilentlyContinue
    if ($item.pv -match '^\d+(?:\.\d+){3}$' -and $item.pv -ne '0.0.0.0') { return $item.pv }
  }
  return $null
}

function Get-ZzPathEntry([string]$Path) {
  if (!$Path -or ![IO.Path]::IsPathRooted($Path)) { return }
  $checked = [IO.Path]::GetFullPath($Path)
  $parent = [IO.Path]::GetDirectoryName($checked)
  if ($parent -and $parent -ne $checked) { $null = Get-ZzPathEntry $parent }
  $entry = Get-Item -LiteralPath $checked -Force -ErrorAction SilentlyContinue
  if ($entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'An installation path contains a link or reparse point.' }
  return $entry
}

function Read-ZzInstallRecord([string]$Path) {
  $entry = Get-ZzPathEntry $Path
  if (!$entry) { return }
  if ($entry.PSIsContainer -or $entry.Length -gt 65536) { throw 'An installation record has an unexpected file type or size.' }
  return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-ZzPreflight([string]$ProjectRoot, [string]$InstallDir, [bool]$Trial) {
  $package = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json
  $requiredPnpm = $package.packageManager.Substring(5)
  $architecture = $env:PROCESSOR_ARCHITEW6432
  if (!$architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
  $isWindowsX64 = $env:OS -eq 'Windows_NT' -and $architecture -eq 'AMD64'
  $node = Get-ZzCommand @('node.exe')
  $pnpm = Get-ZzCommand @('pnpm.cmd')
  $nodeVersion = Get-ZzVersionPrefix (Invoke-ZzProbe $node.Path @('--version'))
  $nodeArch = Invoke-ZzProbe $node.Path @('-p', 'process.arch')
  $nodeReady = $nodeVersion -and $nodeArch -eq 'x64' -and [version]$nodeVersion -ge [version]'24.18.0'
  $pnpmVersion = Get-ZzPnpmVersion $pnpm $requiredPnpm $env:LOCALAPPDATA
  $rust = Get-ZzRustTools (Get-ZzCommand @('rustc.exe')) (Get-ZzCommand @('cargo.exe'))
  $msvc = Get-ZzMsvcVersion
  $webview = Get-ZzWebViewVersion
  $lockfile = Test-Path -LiteralPath (Join-Path $ProjectRoot 'pnpm-lock.yaml') -PathType Leaf
  $tools = [pscustomobject]@{
    node = [pscustomobject]@{ found = [bool]$node; version = $nodeVersion; architecture = $nodeArch; ready = [bool]$nodeReady }
    pnpm = [pscustomobject]@{ found = [bool]$pnpm; version = $pnpmVersion; required = $requiredPnpm; ready = ($pnpmVersion -eq $requiredPnpm) }
    rust = [pscustomobject]@{ rustc = $rust.Rust; cargo = $rust.Cargo; host = $rust.Host; ready = [bool]($rust.Rust -and $rust.Cargo -and $rust.Host -eq 'x86_64-pc-windows-msvc') }
    msvc = [pscustomobject]@{ version = $msvc; ready = [bool]$msvc }
    webView2 = [pscustomobject]@{ version = $webview; ready = [bool]$webview }
  }
  $blockers = @(
    if (!$isWindowsX64) { [pscustomobject]@{ code = 'platform'; detail = 'Use a Windows x64 machine.' } }
    if (!$tools.node.ready) { [pscustomobject]@{ code = 'node'; detail = 'Install Node.js 24.18.0 or newer for Windows x64.' } }
    if (!$tools.pnpm.ready) { [pscustomobject]@{ code = 'pnpm'; detail = "Make pnpm $requiredPnpm available. A Corepack shim needs the pinned version prepared first." } }
    if (!$tools.rust.ready) { [pscustomobject]@{ code = 'rust'; detail = 'Install an x86_64-pc-windows-msvc Rust toolchain with cargo and rustc.' } }
    if (!$tools.msvc.ready) { [pscustomobject]@{ code = 'msvc'; detail = 'Install the Desktop development with C++ workload with x64 MSVC Build Tools and a Windows SDK.' } }
    if (!$tools.webView2.ready) { [pscustomobject]@{ code = 'webview2'; detail = 'Install or repair Microsoft Edge WebView2 Runtime.' } }
    if (!$lockfile) { [pscustomobject]@{ code = 'lockfile'; detail = 'Extract the complete source archive containing pnpm-lock.yaml.' } }
  )
  $buildReady = $isWindowsX64 -and $nodeReady -and $tools.pnpm.ready -and $tools.rust.ready -and $tools.msvc.ready -and $lockfile
  $location = [ordered]@{ directory = $null; dataDir = $null; registration = $null; binding = $null; hasInstalledExecutable = $false; verifiedTrial = $false }
  if ($env:LOCALAPPDATA -and $env:USERPROFILE) {
    $location.registration = Join-Path $env:LOCALAPPDATA 'ZZ Board Portable/location.json'
    $location.binding = Join-Path $env:USERPROFILE '.codex/zz-board.json'
    $defaultName = if ($Trial) { 'ZZ Board Trial' } else { 'ZZ Board' }
    try {
      $registered = Read-ZzInstallRecord $location.registration
      $binding = Read-ZzInstallRecord $location.binding
      if ($registered -and ($registered.schemaVersion -ne 1 -or !$registered.installDir -or ![IO.Path]::IsPathRooted($registered.installDir))) { throw 'The portable registration is invalid.' }
      if ($binding -and ($binding.schemaVersion -ne 1 -or !$binding.desktopExecutable -or ![IO.Path]::IsPathRooted($binding.desktopExecutable) -or
          !$binding.dataDir -or ![IO.Path]::IsPathRooted($binding.dataDir))) { throw 'The existing Codex binding is invalid.' }
      $location.registeredDirectory = $registered.installDir
      $location.boundExecutable = $binding.desktopExecutable
      if ($InstallDir) {
        if (![IO.Path]::IsPathRooted($InstallDir)) { throw 'Use an absolute installation directory.' }
        $location.directory = [IO.Path]::GetFullPath($InstallDir)
      } elseif ($registered.installDir) { $location.directory = $registered.installDir }
      elseif ($binding.desktopExecutable -and !$Trial) { $location.directory = Split-Path -Parent $binding.desktopExecutable }
      else { $location.directory = Join-Path $env:LOCALAPPDATA "Programs/$defaultName" }
      $target = Join-Path $location.directory 'zz-board.exe'
      $location.hasInstalledExecutable = [bool](Get-ZzPathEntry $target)
      $location.dataDir = if ($binding.dataDir) { $binding.dataDir } elseif ($env:ZZ_BOARD_DATA_DIR) { $env:ZZ_BOARD_DATA_DIR }
        elseif ($env:ZZ_BOARD_PROJECT_ROOT) { Join-Path $env:ZZ_BOARD_PROJECT_ROOT '.local-data' }
        else { Join-Path $location.directory '.local-data' }
      if ($Trial) {
        if ($nodeReady) {
          $arguments = @((Join-Path $ProjectRoot 'scripts/source-deployment.mjs'), 'trial-plan')
          if ($InstallDir) { $arguments += $InstallDir }
          $plan = Invoke-ZzProbe $node.Path $arguments
          if (!$plan) { throw 'This configuration cannot be used for an isolated trial. Check the existing installation, binding and data location. Use a separate Windows user or VM.' }
          $state = $plan | ConvertFrom-Json
          $location.directory = $state.directory
          $location.dataDir = $state.dataDir
          $location.hasInstalledExecutable = [bool]$state.installed
          $location.verifiedTrial = [bool]$state.installed
        } elseif ($registered -or $binding -or $location.hasInstalledExecutable -or [bool](Get-ZzPathEntry (Join-Path $env:LOCALAPPDATA 'Programs/ZZ Board/zz-board.exe'))) {
          throw 'An existing installation must be verified with Node before proceeding. Use an isolated Windows profile for this trial.'
        }
      } elseif ($binding.desktopExecutable -and $binding.desktopExecutable -ne $target) {
        throw 'The current Codex binding points to another installation. Review the binding and proposed path before deployment.'
      }
    } catch { $blockers += [pscustomobject]@{ code = 'existing_installation'; detail = $_.Exception.Message } }
  } else {
    $blockers += [pscustomobject]@{ code = 'profile'; detail = 'Open a normal interactive Windows user session to resolve the local data paths.' }
  }
  try {
    $occupied = [bool](@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object Port -eq 4318).Count)
    $portState = if ($occupied) { 'occupied' } else { 'available' }
  } catch { $portState = 'unverified' }
  if ($portState -ne 'available') {
    $blockers += [pscustomobject]@{ code = 'port_conflict'; detail = 'Save work and truly quit ZZ Board from the tray. Use -Status to reuse a matching running trial, or move to an isolated VM.' }
  }
  return [pscustomobject]@{ schemaVersion = 1; mode = 'preflight'; trial = $Trial; appVersion = $package.version; ready = $blockers.Count -eq 0;
    buildReady = $buildReady; platform = [pscustomobject]@{ windowsX64 = $isWindowsX64; architecture = $architecture }; tools = $tools;
    installation = [pscustomobject]$location; port = [pscustomobject]@{ number = 4318; state = $portState }; blockers = $blockers }
}
