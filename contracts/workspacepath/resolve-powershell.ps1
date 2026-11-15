$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
function Fail($code) { [Console]::Error.WriteLine("AIH_PATH:$code"); exit 73 }
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
public static class AihFinalPath {
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr z,uint c,uint f,IntPtr t);
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder b,uint n,uint f);
public static string Get(string p){using(var h=CreateFileW(p,0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero)){if(h.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,b,(uint)b.Capacity,0);if(n==0||n>=b.Capacity)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());return b.ToString();}}
}
'@
function Final($p) { try { return [AihFinalPath]::Get($p) } catch { Fail 'path_resolution_failed' } }
function Inside($p) { if($p -cne $rootReal -and -not $p.StartsWith($rootReal.TrimEnd('\')+'\',[StringComparison]::Ordinal)){Fail 'path_outside_workspace'} }
try {
  if($rel -match '(^[\/]|:|[\x00-\x1f]|[<>"|?*])'){Fail 'invalid_path'}
  $parts=@($rel.Replace('/','\').Split('\') | Where-Object {$_ -ne '' -and $_ -ne '.'})
  if($parts -contains '..'){Fail 'invalid_path'}
  foreach($p in $parts){if($p.EndsWith('.') -or $p.EndsWith(' ') -or $p -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)'){Fail 'invalid_path'}}
  $rootItem=Get-Item -LiteralPath $root -Force
  if(-not $rootItem.PSIsContainer){Fail 'not_directory'}
  $rootReal=Final $root
  if($rootReal -notmatch '^\\\\\?\\[A-Za-z]:\\$'){$rootReal=$rootReal.TrimEnd('\')}
  if($expected -and $rootReal -cne $expected){Fail 'workspace_root_changed'}
  $current=$rootReal; $target=$rootReal; $entry=$rootReal; $missing=$false
  for($i=0;$i -lt $parts.Count;$i++){
    $entry=$current.TrimEnd('\')+'\'+$parts[$i]
    $last=$i -eq $parts.Count-1
    if($last -and $mode -eq 'remove'){$target=$entry;break}
    if($missing){$current=$entry;$target=$entry;continue}
    $item=$null
    try{$item=Get-Item -LiteralPath $entry -Force -ErrorAction Stop}catch [System.Management.Automation.ItemNotFoundException]{
      $parent=[IO.Path]::GetDirectoryName($entry)
      $leaf=[IO.Path]::GetFileName($entry)
      $known=@(Get-ChildItem -LiteralPath $parent -Force -ErrorAction Stop | Where-Object {[string]::Equals($_.Name,$leaf,[StringComparison]::OrdinalIgnoreCase)})
      if($known.Count -gt 0){Fail 'path_resolution_failed'}
      if($mode -ne 'replace'){Fail 'not_found'}
      $missing=$true;$current=$entry;$target=$entry;continue
    }
    $target=Final $entry;Inside $target
    if(-not $last -and -not $item.PSIsContainer){Fail 'not_directory'}
    $current=$target
  }
  if($parts.Count -eq 0 -and $mode -ne 'read'){Fail 'invalid_path'}
  Inside $target
  $io=$target;if($mode -eq 'remove' -or $mode -eq 'replace'){$io=$entry}
  [Console]::Out.Write($rootReal+[char]0+$target+[char]0+$io+[char]0)
}catch{Fail 'path_query_failed'}
