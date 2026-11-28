param(
  [string]$DriverPath = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'aih-netguard.sys'),
  [switch]$Start
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $DriverPath)) { throw "missing $DriverPath; run build.ps1 and sign.ps1 first" }

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'install.ps1 must run as administrator'
}

$signature = Get-AuthenticodeSignature $DriverPath
Write-Host ('signature: ' + $signature.Status)

$target = Join-Path $env:SystemRoot 'System32\drivers\aihnetguard.sys'
sc.exe query AihNetGuard *> $null
if ($LASTEXITCODE -eq 0) {
  sc.exe stop AihNetGuard *> $null
  sc.exe config AihNetGuard binPath= $target start= demand type= kernel | Out-Null
} else {
  sc.exe create AihNetGuard binPath= $target start= demand type= kernel error= normal | Out-Null
}
if ($LASTEXITCODE -ne 0) { throw 'sc create/config failed' }
Copy-Item $DriverPath $target -Force
Write-Host ('installed: ' + $target)

if ($Start) {
  sc.exe start AihNetGuard
  if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'The driver did not start. Error 577 means test signing is not active.'
    Write-Host 'Enable it once (Secure Boot must be off), then reboot:'
    Write-Host '  bcdedit /set testsigning on'
    Write-Host '  shutdown /r /t 0'
    exit $LASTEXITCODE
  }
  sc.exe query AihNetGuard
}