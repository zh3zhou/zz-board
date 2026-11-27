param(
  [Parameter(Mandatory=$true)][ValidateSet('Observe','Open')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Executable
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($Action -eq 'Open') {
  # The user requested the interactive desktop window. A second invocation
  # asks Tauri's single-instance handler to show a hidden matching window.
  Start-Process -FilePath $Executable -WorkingDirectory (Split-Path -Parent $Executable)
  return
}
Add-Type -Namespace ZZBoard -Name Window -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr hWnd);
'@
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
$rows = @(foreach ($p in (Get-Process -Name 'zz-board','zz-board.previous' -ErrorAction SilentlyContinue)) {
  if ($p.SessionId -ne $session) { continue }
  $filename = $p.Path
  if (-not $filename) {
    [pscustomobject]@{ pid=$p.Id; executable=$null; matches=$false; visible=$false }
    continue
  }
  $product = [Diagnostics.FileVersionInfo]::GetVersionInfo($filename)
  if ($product.ProductName -ne 'ZZ Board' -or $product.CompanyName -ne 'zzboard') { continue }
  $hwnd = $p.MainWindowHandle
  [pscustomobject]@{
    pid=$p.Id; executable=$filename; matches=($filename -eq $Executable)
    visible=($hwnd -ne [IntPtr]::Zero -and [ZZBoard.Window]::IsWindowVisible($hwnd))
  }
})
ConvertTo-Json -InputObject $rows -Compress
