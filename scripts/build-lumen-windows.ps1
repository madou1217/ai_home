<#
.SYNOPSIS
Builds the Windows native Paste Lumen V7 WPF executables (standalone aih-lumen.exe and/or
the integrated AIH desktop helper aih-translation.exe).

.PARAMETER Target
Which target to publish: "all" (default), "lumen" (standalone Paste Lumen V7), or "helper"
(integrated Translation + Launcher + Paste Lumen V7 helper).

.PARAMETER Arch
Target Windows architecture: "x64" (default) or "arm64".

.PARAMETER Configuration
MSBuild configuration: "Release" (default) or "Debug".

.PARAMETER OutputDir
Optional output directory. Defaults to <repo>\bin\native\win32-<arch>.
#>
[CmdletBinding()]
param(
  [ValidateSet('all', 'lumen', 'helper')]
  [string]$Target = 'all',

  [ValidateSet('x64', 'arm64')]
  [string]$Arch = 'x64',

  [ValidateSet('Release', 'Debug')]
  [string]$Configuration = 'Release',

  [string]$OutputDir = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $RepoRoot (Join-Path 'bin' (Join-Path 'native' "win32-$Arch"))
}

$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnet) {
  throw 'dotnet SDK 8.0+ (Windows Desktop workload) was not found on PATH. Install .NET 8 SDK on Windows first.'
}

$rid = "win-$Arch"
$expectedMachine = if ($Arch -eq 'arm64') { [uint16]0xAA64 } else { [uint16]0x8664 }

function Assert-WindowsPeBinary {
  param(
    [Parameter(Mandatory = $true)][string]$BinaryPath,
    [Parameter(Mandatory = $true)][uint16]$ExpectedMachine
  )
  if (-not (Test-Path -LiteralPath $BinaryPath)) {
    throw "Expected output binary not found: $BinaryPath"
  }
  $fs = [System.IO.File]::OpenRead($BinaryPath)
  try {
    $header = New-Object byte[] 64
    $read = $fs.Read($header, 0, 64)
    if ($read -lt 64 -or $header[0] -ne 0x4D -or $header[1] -ne 0x5A) {
      throw "Invalid PE header (missing MZ) in $BinaryPath"
    }
    $peOffset = [System.BitConverter]::ToUInt32($header, 60)
    $null = $fs.Seek([int64]$peOffset, [System.IO.SeekOrigin]::Begin)
    $sig = New-Object byte[] 6
    $readSig = $fs.Read($sig, 0, 6)
    if ($readSig -lt 6 -or $sig[0] -ne 0x50 -or $sig[1] -ne 0x45 -or $sig[2] -ne 0 -or $sig[3] -ne 0) {
      throw "Invalid PE signature in $BinaryPath"
    }
    $machine = [System.BitConverter]::ToUInt16($sig, 4)
    if ($machine -ne $ExpectedMachine) {
      throw ("PE architecture mismatch in {0}: got 0x{1:X4}, expected 0x{2:X4}" -f $BinaryPath, $machine, $ExpectedMachine)
    }
  } finally {
    $fs.Dispose()
  }
}

function Publish-NativeTarget {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRelPath,
    [Parameter(Mandatory = $true)][string]$ExeName
  )
  $projectFull = Join-Path $RepoRoot $ProjectRelPath
  if (-not (Test-Path -LiteralPath $projectFull)) {
    throw "Project file not found: $projectFull"
  }

  $stageOut = Join-Path ([System.IO.Path]::GetTempPath()) ("aih-lumen-publish-" + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stageOut -Force | Out-Null
  New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

  try {
    Write-Host "[lumen-win] Publishing $ProjectRelPath ($Configuration, $rid)..."
    $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
    $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
    $env:DOTNET_NOLOGO = '1'

    & dotnet publish $projectFull `
      --configuration $Configuration `
      --runtime $rid `
      --self-contained true `
      -p:PublishSingleFile=true `
      -p:IncludeNativeLibrariesForSelfExtract=true `
      -p:EnableCompressionInSingleFile=true `
      --output $stageOut

    if ($LASTEXITCODE -ne 0) {
      throw "dotnet publish failed for $ProjectRelPath with exit code $LASTEXITCODE"
    }

    $builtExe = Join-Path $stageOut $ExeName
    Assert-WindowsPeBinary -BinaryPath $builtExe -ExpectedMachine $expectedMachine

    $destExe = Join-Path $OutputDir $ExeName
    Copy-Item -LiteralPath $builtExe -Destination $destExe -Force
    $hash = (Get-FileHash -LiteralPath $destExe -Algorithm SHA256).Hash
    $sizeMb = [Math]::Round(((Get-Item -LiteralPath $destExe).Length / 1MB), 2)
    Write-Host "[lumen-win] Built $destExe (${sizeMb} MiB, sha256=$hash)"
  } finally {
    if (Test-Path -LiteralPath $stageOut) {
      Remove-Item -LiteralPath $stageOut -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($Target -eq 'all' -or $Target -eq 'lumen') {
  Publish-NativeTarget -ProjectRelPath 'native\clipboard\windows\LumenClipboard.csproj' -ExeName 'aih-lumen.exe'
}

if ($Target -eq 'all' -or $Target -eq 'helper') {
  Publish-NativeTarget -ProjectRelPath 'native\translation\windows\AihTranslation.csproj' -ExeName 'aih-translation.exe'
}

Write-Host '[lumen-win] Done.'
