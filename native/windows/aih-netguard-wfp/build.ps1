$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$wdk = Join-Path $env:TEMP 'wdk-nuget\x\c'
$wdkVer = '10.0.28000.0'
$sdk = 'C:\Program Files (x86)\Windows Kits\10'
# The installed SDK 28000 and the WDK NuGet package ship no base `shared`
# headers (ntdef.h, dpfilter.h, ...), so the WDK 28000 `km` headers cannot be
# compiled self-consistently. Use the complete, matched 16299 header tree from
# the winsdk-10 mirror for compilation; the WFP/UCRT ABI used here is stable
# across versions. Link against the WDK 28000 kernel import libraries.
$legacy = Join-Path $env:TEMP 'winsdk10\winsdk-10-master\Include\10.0.16299.0'
$msvc = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207'
$cl = Join-Path $msvc 'bin\Hostx64\x64\cl.exe'
$link = Join-Path $msvc 'bin\Hostx64\x64\link.exe'
$includes = @(
  (Join-Path $legacy 'km'),
  (Join-Path $legacy 'km\crt'),
  (Join-Path $legacy 'shared'),
  (Join-Path $legacy 'ucrt'),
  (Join-Path $msvc 'include')
)
$libs = @(
  (Join-Path $wdk "Lib\$wdkVer\km\x64"),
  (Join-Path $msvc 'lib\x64')
)
$includeArgs = $includes | ForEach-Object { "/I$_" }
$libArgs = $libs | ForEach-Object { "/LIBPATH:$_" }
$obj = Join-Path $root 'driver.obj'
& $cl /nologo /c /kernel /GS- /Zl /W4 /D_AMD64_ /DAMD64 /D_WIN64 /DWIN64 /DNTDDI_VERSION=0x0A000000 /D_WIN32_WINNT=0x0A00 /DNDIS60=1 /DNDIS_SUPPORT_NDIS6=1 /DPOOL_NX_OPTIN=1 @includeArgs (Join-Path $root 'driver.c') "/Fo$obj"
if ($LASTEXITCODE -ne 0) { throw "cl failed: $LASTEXITCODE" }
& $link /nologo /DRIVER /SUBSYSTEM:NATIVE /ENTRY:DriverEntry /NODEFAULTLIB /MACHINE:X64 @libArgs "/OUT:$root\aih-netguard.sys" (Join-Path $root 'driver.obj') ntoskrnl.lib fwpkclnt.lib wdmsec.lib
if ($LASTEXITCODE -ne 0) { throw "link failed: $LASTEXITCODE" }
Get-Item (Join-Path $root 'aih-netguard.sys') | Select-Object FullName,Length
