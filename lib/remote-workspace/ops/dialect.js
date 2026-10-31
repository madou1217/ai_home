'use strict';

// 远端「方言」：同一个操作在 POSIX sh 与 Windows PowerShell 上的命令写法（Strategy）。
//
// 只用远端系统自带的东西（sh/base64/find/grep 或 PowerShell），不往远端放任何程序。
// 所有路径、模式都经过本模块的引用函数转义后才进命令行；调用方不手拼命令。
//
// detect() 用一条两边都能跑的命令判型：POSIX 下 `uname` 有输出；Windows OpenSSH 的默认
// shell 是 cmd 或 PowerShell，都会对 `uname` 报错，再用 PowerShell 确认。

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 任意长度的 PowerShell 脚本 → {command, stdin}。
 * Windows 命令行上限 32767 字符，-EncodedCommand（UTF-16LE base64）把脚本放大约 2.7 倍，
 * 超过约 8KB 的脚本改为：命令行只放一个固定的小引导程序，真正的脚本经 stdin（UTF-8 base64）传入。
 */
const PS_INLINE_LIMIT = 8 * 1024;
const PS_STDIN_BOOTSTRAP = '$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); Invoke-Expression $s';

function psScript(script) {
  const text = String(script);
  if (text.length <= PS_INLINE_LIMIT) return { command: psEncoded(text), stdin: undefined };
  return { command: psEncoded(PS_STDIN_BOOTSTRAP), stdin: Buffer.from(text, 'utf8').toString('base64') };
}

function psEncoded(script) {
  // -EncodedCommand：UTF-16LE base64，不受默认 shell（cmd / PowerShell）引号规则影响。
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

const POSIX = Object.freeze({
  id: 'posix',
  pathSep: '/',
  joinPath: (root, rel) => (rel ? `${String(root).replace(/\/+$/, '')}/${String(rel).replace(/^\/+/, '')}` : String(root)),
  /** 读文件 → stdout 为 base64（避免二进制 / 编码问题），第一行是 size mtime。 */
  readFile: (absPath) => `f=${shQuote(absPath)}; [ -f "$f" ] || { echo NOENT >&2; exit 3; }; `
    + `(stat -c '%s %Y' "$f" 2>/dev/null || stat -f '%z %m' "$f"); base64 < "$f" | tr -d '\\n'`,
  /** 原子写：stdin 是 base64 内容 → 同目录临时文件 → mv 覆盖。 */
  writeFile: (absPath) => `f=${shQuote(absPath)}; d=$(dirname "$f"); mkdir -p "$d" || exit 4; `
    + `t="$d/.aih-write.$$"; (base64 -d 2>/dev/null || base64 -D) > "$t" && mv -f "$t" "$f" || { rm -f "$t"; exit 5; }; `
    + `(stat -c '%s %Y' "$f" 2>/dev/null || stat -f '%z %m' "$f")`,
  /**
   * 列目录：每行 type\\tsize\\tmtime\\tname。一次 stat 调用列完（不按文件 fork），
   * GNU stat（Linux）输出类型名 %F，BSD stat（macOS）输出 %HT，由 file-ops-exec 归一。
   * 两种 stat 默认都不跟随符号链接。
   */
  listDir: (absPath) => `d=${shQuote(absPath)}; [ -d "$d" ] || { echo NOENT >&2; exit 3; }; cd "$d" || exit 3; `
    + `set --; for n in * .[!.]* ..?*; do { [ -e "$n" ] || [ -L "$n" ]; } && set -- "$@" "$n"; done; [ $# -eq 0 ] && exit 0; `
    + `if stat -c %s . >/dev/null 2>&1; then stat --printf '%F\\t%s\\t%Y\\t%n\\n' -- "$@"; else stat -f '%HT%t%z%t%m%t%N' -- "$@"; fi 2>/dev/null; exit 0`,
  stat: (absPath) => `f=${shQuote(absPath)}; [ -e "$f" ] || { echo NOENT >&2; exit 3; }; `
    + `if [ -d "$f" ]; then t=d; else t=f; fi; s=$(stat -c '%s %Y' "$f" 2>/dev/null || stat -f '%z %m' "$f"); printf '%s %s' "$t" "$s"`,
  remove: (absPath) => `rm -rf -- ${shQuote(absPath)}`,
  /** 搜索：有 rg 用 rg，否则 grep -rn。输出 path:line:text。 */
  search: (absRoot, pattern, { maxResults }) => `cd ${shQuote(absRoot)} || exit 3; `
    + `if command -v rg >/dev/null 2>&1; then rg -n --no-heading --color never -m 50 --max-count 50 -e ${shQuote(pattern)} . | head -n ${Number(maxResults)}; `
    + `else grep -rIn --exclude-dir=.git --exclude-dir=node_modules -e ${shQuote(pattern)} . | head -n ${Number(maxResults)}; fi`,
  /** 在工作区目录下执行任意命令（AI 工具调用）；用户的登录 shell 环境。 */
  run: (absRoot, command) => `cd ${shQuote(absRoot)} && ${command}`,
  /**
   * 用用户的登录 shell 执行脚本，拿到用户级 PATH（~/.cargo/bin、Homebrew、nvm 等）：
   * 非交互 ssh 会话的 PATH 只有系统默认值。只认 bash / zsh（与 POSIX 脚本兼容），其余用 sh。
   */
  loginShell: (script) => `s=sh; case "\${SHELL##*/}" in bash|zsh) s="$SHELL" ;; esac; "$s" -lc ${shQuote(script)}`,
  /**
   * 用户级工具目录补进 PATH：npm 全局 bin（npm install -g 的落点，常不在 PATH 里）。
   * 只在 npm 存在时补，补在 PATH 末尾（不改变用户已有的优先级）。
   */
  userToolPath: () => 'if command -v npm >/dev/null 2>&1; then p=$(npm prefix -g 2>/dev/null) && [ -d "$p/bin" ] && PATH="$PATH:$p/bin"; fi; export PATH',
  probeTools: () => 'for t in git rg base64 inotifywait fswatch tmux; do command -v "$t" >/dev/null 2>&1 && printf "%s " "$t"; done; echo; uname -s',
  quote: shQuote
});

const POWERSHELL = Object.freeze({
  id: 'powershell',
  pathSep: '\\',
  joinPath: (root, rel) => (rel ? `${String(root).replace(/[\\/]+$/, '')}\\${String(rel).replace(/^[\\/]+/, '').replace(/\//g, '\\')}` : String(root)),
  readFile: (absPath) => psEncoded(`$ErrorActionPreference='Stop'; $f=${psQuote(absPath)}; if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { [Console]::Error.Write('NOENT'); exit 3 };`
    + ` $i=Get-Item -LiteralPath $f; [Console]::Out.WriteLine("$($i.Length) $([int][double]::Parse((Get-Date $i.LastWriteTimeUtc -UFormat %s)))");`
    + ` [Console]::Out.Write([Convert]::ToBase64String([IO.File]::ReadAllBytes($f)))`),
  writeFile: (absPath) => psEncoded(`$ErrorActionPreference='Stop'; $f=${psQuote(absPath)}; $d=Split-Path -Parent $f; New-Item -ItemType Directory -Force -Path $d | Out-Null;`
    + ` $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $t=Join-Path $d (".aih-write." + $PID);`
    + ` [IO.File]::WriteAllBytes($t,$b); Move-Item -LiteralPath $t -Destination $f -Force;`
    + ` $i=Get-Item -LiteralPath $f; [Console]::Out.Write("$($i.Length) $([int][double]::Parse((Get-Date $i.LastWriteTimeUtc -UFormat %s)))")`),
  listDir: (absPath) => psEncoded(`$ErrorActionPreference='Stop'; $d=${psQuote(absPath)}; if (-not (Test-Path -LiteralPath $d -PathType Container)) { [Console]::Error.Write('NOENT'); exit 3 };`
    + ` Get-ChildItem -LiteralPath $d -Force | ForEach-Object { $t = if ($_.LinkType) {'l'} elseif ($_.PSIsContainer) {'d'} else {'f'};`
    + ` $s = if ($_.PSIsContainer) {0} else {$_.Length}; $m=[int][double]::Parse((Get-Date $_.LastWriteTimeUtc -UFormat %s));`
    + ` [Console]::Out.WriteLine("$t\`t$s\`t$m\`t$($_.Name)") }`),
  stat: (absPath) => psEncoded(`$f=${psQuote(absPath)}; if (-not (Test-Path -LiteralPath $f)) { [Console]::Error.Write('NOENT'); exit 3 };`
    + ` $i=Get-Item -LiteralPath $f; $t = if ($i.PSIsContainer) {'d'} else {'f'}; $s = if ($i.PSIsContainer) {0} else {$i.Length};`
    + ` [Console]::Out.Write("$t $s $([int][double]::Parse((Get-Date $i.LastWriteTimeUtc -UFormat %s)))")`),
  remove: (absPath) => psEncoded(`Remove-Item -LiteralPath ${psQuote(absPath)} -Recurse -Force -ErrorAction SilentlyContinue`),
  search: (absRoot, pattern, { maxResults }) => psEncoded(`Set-Location -LiteralPath ${psQuote(absRoot)};`
    + ` if (Get-Command rg -ErrorAction SilentlyContinue) { rg -n --no-heading --color never -e ${psQuote(pattern)} . | Select-Object -First ${Number(maxResults)} }`
    + ` else { Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\\\(\\.git|node_modules)\\\\' } |`
    + ` Select-String -Pattern ${psQuote(pattern)} | Select-Object -First ${Number(maxResults)} | ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line)" } }`),
  run: (absRoot, command) => psEncoded(`Set-Location -LiteralPath ${psQuote(absRoot)}; ${command}`),
  probeTools: () => psEncoded(`$o=@(); foreach ($t in 'git','rg') { if (Get-Command $t -ErrorAction SilentlyContinue) { $o += $t } }; [Console]::Out.WriteLine(($o -join ' ')); [Console]::Out.Write('Windows')`),
  quote: psQuote
});

const DIALECTS = Object.freeze({ posix: POSIX, powershell: POWERSHELL });

/** 判型命令：POSIX 输出 `posix:<uname>`；Windows（cmd 或 PowerShell 默认 shell）都会走到 PowerShell 分支。 */
const DETECT_COMMAND = 'uname -s 2>/dev/null && echo AIH_POSIX || powershell -NoProfile -Command "Write-Output AIH_WINDOWS"';

function parseDetect(stdout) {
  const text = String(stdout || '');
  if (/AIH_POSIX/.test(text)) return { dialect: POSIX, os: text.split(/\r?\n/)[0].trim() || 'posix' };
  if (/AIH_WINDOWS/.test(text)) return { dialect: POWERSHELL, os: 'Windows' };
  return null;
}

module.exports = {
  DETECT_COMMAND,
  DIALECTS,
  POSIX,
  POWERSHELL,
  parseDetect,
  psEncoded,
  psScript,
  psQuote,
  shQuote
};
