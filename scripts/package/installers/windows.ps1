# AI Home 便携版 Windows 安装脚本。
param(
  [string]$Prefix = "$env:LOCALAPPDATA\aih",
  [switch]$Uninstall,
  [switch]$PreserveExisting,
  [switch]$NoPath
)
$ErrorActionPreference = 'Stop'
$Version = '__AIH_VERSION__'

function Assert-InstallPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Empty installation path' }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $root = [IO.Path]::GetPathRoot($full).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $homePath = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $state = if ($env:AIH_HOME_DIR) { $env:AIH_HOME_DIR } else { Join-Path $homePath '.ai_home' }
  $state = [IO.Path]::GetFullPath($state).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ($full -eq $root -or $full -eq $homePath -or $full -eq $state -or
      $state.StartsWith($full + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      $homePath.StartsWith($full + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      $full.StartsWith($state + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing root, HOME or AIH data directory'
  }
  $cursor = $full
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Installation path contains a reparse point' }
    }
    $parent = Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
  return $full
}

$Prefix = Assert-InstallPath $Prefix
$marker = Join-Path $Prefix '.aih-install-owner'
function Test-OwnedInstall {
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return $false }
  if (((Get-Item -LiteralPath $marker -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  $lines = @(Get-Content -LiteralPath $marker -Encoding UTF8)
  return $lines.Count -eq 2 -and $lines[0] -eq 'aih-owned-install-v1' -and $lines[1] -eq $Prefix
}

if ($Uninstall) {
  if (-not (Test-Path -LiteralPath $Prefix)) { Write-Host '[aih] 安装目录不存在，无需卸载'; exit 0 }
  if (-not (Test-OwnedInstall)) { throw 'Refusing to remove unowned installation; missing or mismatched ownership receipt' }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($userPath -split ';' | Where-Object { $_ -and $_ -ne $Prefix })
  [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
  Remove-Item -LiteralPath $Prefix -Recurse -Force
  Write-Host "[aih] 已卸载（$Prefix）；用户数据保留"
  exit 0
}

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $source 'aih.exe'
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "这不是完整的安装包：找不到 $launcher"
}

$source = [IO.Path]::GetFullPath($source).TrimEnd([IO.Path]::DirectorySeparatorChar)
if ($source -eq $Prefix -or $source.StartsWith($Prefix + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    $Prefix.StartsWith($source + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Source and installation target must not overlap' }
if (Test-Path -LiteralPath $Prefix) {
  if (-not (Test-Path -LiteralPath $Prefix -PathType Container)) { throw 'Installation path is not a directory' }
  if (@(Get-ChildItem -LiteralPath $Prefix -Force).Count -gt 0 -and -not (Test-OwnedInstall) -and -not $PreserveExisting) { throw 'Existing directory is not owned; use -PreserveExisting to move it aside without deletion' }
}
$parent = Split-Path -Parent $Prefix
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$nonce = [Guid]::NewGuid().ToString('N')
$stage = "$Prefix.new.$nonce"
$old = "$Prefix.old.$nonce"
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  foreach ($item in Get-ChildItem -LiteralPath $source -Force) {
    Copy-Item -LiteralPath $item.FullName -Destination $stage -Recurse -Force
  }
  foreach ($required in @('aih.exe', 'bin\ai-home.js', 'runtime\node.exe', 'BUILD_INFO.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage $required) -PathType Leaf)) { throw "Incomplete staged bundle: $required" }
  }
  $build = Get-Content -LiteralPath (Join-Path $stage 'BUILD_INFO.json') -Encoding UTF8 -Raw | ConvertFrom-Json
  if ($build.target -notmatch '^win32-(x64|arm64)$') { throw 'Invalid Windows bundle target' }
  foreach ($native in @('aih-server.exe', 'aih-go.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage ("bin\native\{0}\{1}" -f $build.target, $native)) -PathType Leaf)) { throw "Missing staged native component: $native" }
  }
  $stageMarker = Join-Path $stage '.aih-install-owner'
  if (Test-Path -LiteralPath $stageMarker) { Remove-Item -LiteralPath $stageMarker -Force }
  [IO.File]::WriteAllLines($stageMarker, @('aih-owned-install-v1', $Prefix), (New-Object Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $Prefix) {
    Move-Item -LiteralPath $Prefix -Destination $old
    try { Move-Item -LiteralPath $stage -Destination $Prefix }
    catch { Move-Item -LiteralPath $old -Destination $Prefix; throw }
    if ($PreserveExisting) { Write-Host "[aih] 旧目录完整保留：$old" } else { Remove-Item -LiteralPath $old -Recurse -Force }
  } else {
    Move-Item -LiteralPath $stage -Destination $Prefix
  }
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}

if (-not $NoPath) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($userPath -split ';' | Where-Object { $_ })
  if ($parts -notcontains $Prefix) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $Prefix) -join ';'), 'User')
  }
}

Write-Host "[aih] 已安装 $Version 到 $Prefix"
Write-Host "[aih] 新开一个终端后运行: aih help"
Write-Host "[aih] 数据目录仍是 %USERPROFILE%\.ai_home（可用 AIH_HOME_DIR 修改）"
