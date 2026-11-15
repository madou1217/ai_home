# Variables root, pattern, maximum, preferRg, skipIgnored are supplied literally.
# Never recurse through a reparse directory or pass a reparse file to content I/O.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
Set-Location -LiteralPath $root
if($preferRg -and (Get-Command rg -ErrorAction SilentlyContinue)){
  & rg --no-config --no-follow -n --no-heading --color never -e $pattern . | Select-Object -First $maximum
}else{
  $pending=New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($root)
  $found=0
  while($pending.Count -gt 0 -and $found -lt $maximum){
    $directory=$pending.Pop()
    foreach($entry in (Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)){
      if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){continue}
      if($entry.PSIsContainer){
        if(-not $skipIgnored -or $entry.Name -notin @('.git','node_modules')){$pending.Push($entry.FullName)}
      }else{
        foreach($hit in (Select-String -LiteralPath $entry.FullName -Pattern $pattern)){
          [Console]::Out.WriteLine($hit.Path+':'+$hit.LineNumber+':'+$hit.Line)
          $found++;if($found -ge $maximum){break}
        }
      }
      if($found -ge $maximum){break}
    }
  }
}
