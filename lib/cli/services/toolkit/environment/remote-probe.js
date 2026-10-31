'use strict';

// 远端探测适配：让 probe.js 的探测逻辑原样跑在远端机器上（Adapter）。
//
// probe.js 只通过三类原语接触「本机」：
//   1. execCommandAsync(command, args)  ——执行一条命令拿 {ok, status, stdout, stderr, value}
//   2. fs.existsSync / fs.readdirSync   ——查看已知目录（~/.nvm、~/.pyenv/versions ……）
//   3. hostHomeDir / platform          ——家目录与平台（决定路径分隔符与 which / where.exe）
// 这里为远端提供同形的三类原语。
//
// 效率：一次环境汇总要发 40+ 个探测。直连远端逐条执行要 40+ 个往返，所以按「同一事件循环
// 轮次」把探测攒成一批，拼成一条远端脚本一次执行（Batching）：命令批一次往返，文件系统
// 快照一次往返，整份汇总通常 3~4 个往返。
//
// 文件系统：probe.js 的 fs 调用是同步的。远端不能同步读，所以先把探测需要的目录一次性拍成
// 快照（存在性 + 子目录名），再交给同步的 fs 视图读取。快照之外的路径一律视为不存在。

const nodePath = require('node:path');
const { POSIX, psEncoded, psQuote, psScript, shQuote } = require('../../../../remote-workspace/ops/dialect');
const { ENVIRONMENT_RUNTIME_PLUGINS } = require('./plugins');

const BATCH_MARK = '__AIH_PROBE__';
const PROBE_TIMEOUT_MS = 20_000;

// probe.js 及插件会看的目录（相对家目录）。新增依赖文件系统的探测时在这里登记。
const SNAPSHOT_DIRS = Object.freeze([
  '.nvm',
  '.nvm/versions/node',
  '.pyenv',
  '.pyenv/versions',
  'miniconda3',
  'miniconda3/envs',
  'anaconda3',
  'anaconda3/envs',
  '.conda/envs',
  '.goenv/versions'
]);

// 插件声明的已知安装位置（PATH 里找不到时 probe.js 按这些路径兜底）：远端快照一并查存在性。
function knownFilePaths() {
  const paths = new Set();
  for (const plugin of ENVIRONMENT_RUNTIME_PLUGINS) {
    for (const value of plugin.knownPaths || []) paths.add(value);
    for (const tool of plugin.tools) for (const value of (tool.probe && tool.probe.knownPaths) || []) paths.add(value);
  }
  return [...paths];
}

function posixCommandLine(command, args) {
  return [command, ...args].map(shQuote).join(' ');
}

function windowsCommandLine(command, args) {
  return `& ${[command, ...args].map(psQuote).join(' ')}`;
}

/**
 * 把一批命令拼成一条远端脚本：每条命令单独执行（互不影响），输出带分隔标记与退出码。
 * 每条命令都把 stdout 与 stderr 分开 base64 编码，内容里有什么字符都不会破坏帧格式。
 */
function buildPosixBatch(items) {
  // 每条命令在后台并发执行，结果写进各自的临时文件，全部结束后按序输出：
  // 40 个 `--version` 串行要 ~0.6s，并发后约等于最慢的那一个。
  const jobs = items.map(({ command, args }, index) => (
    `( ${posixCommandLine(command, args)} >"$d/${index}.o" 2>"$d/${index}.e" </dev/null; echo $? >"$d/${index}.c" ) &`
  ));
  const report = `i=0; while [ $i -lt ${items.length} ]; do `
    + `printf '${BATCH_MARK} %s %s ' "$i" "$(cat "$d/$i.c" 2>/dev/null || echo 127)"; `
    + `base64 <"$d/$i.o" | tr -d '\\n'; printf ' '; base64 <"$d/$i.e" | tr -d '\\n'; printf '\\n'; i=$((i+1)); done`;
  // 整批放进用户的登录 shell：探测看到的 PATH 与用户 ssh 登录后一致。
  return POSIX.loginShell([
    POSIX.userToolPath(),
    'd=$(mktemp -d 2>/dev/null || { d=/tmp/aih-probe.$$; mkdir -p "$d"; echo "$d"; })',
    'trap \'rm -rf "$d"\' EXIT',
    ...jobs,
    'wait',
    report
  ].join('\n'));
}

function buildWindowsBatch(items) {
  // 并发执行：每条命令一个独立进程（System.Diagnostics.Process，Windows PowerShell 5.1 自带），
  // 全部启动后统一等待；40 条 `--version` 串行要数秒（每个外部进程冷启动 50~150ms）。
  // 命令名经 Get-Command 解析成真实文件（.exe / .cmd / .ps1），.ps1 由 powershell -File 执行。
  const list = items.map(({ command, args }) => `@(${[command, ...args].map(psQuote).join(',')})`).join(',\n');
  const script = String.raw`$ErrorActionPreference='Continue'; $ProgressPreference='SilentlyContinue'
$items = @(
${list}
)
function Quote-Arg([string]$a) { if ($a -eq '') { return '""' }; if ($a -notmatch '[\s"]') { return $a }; return '"' + ($a -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }
$procs = @()
for ($i = 0; $i -lt $items.Count; $i++) {
  $argv = @($items[$i]); $name = [string]$argv[0]; $rest = @(); if ($argv.Count -gt 1) { $rest = $argv[1..($argv.Count - 1)] }
  $cmd = Get-Command $name -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { $procs += ,@($i, $null, "The term '$name' is not recognized"); continue }
  $file = $cmd.Source; $argText = ($rest | ForEach-Object { Quote-Arg $_ }) -join ' '
  if ($file -match '\.ps1$') { $argText = '-NoProfile -ExecutionPolicy Bypass -File ' + (Quote-Arg $file) + ' ' + $argText; $file = 'powershell.exe' }
  elseif ($file -match '\.(cmd|bat)$') { $argText = '/d /c "' + (Quote-Arg $file) + ' ' + $argText + '"'; $file = $env:ComSpec }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file; $psi.Arguments = $argText; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
  try { $p = [System.Diagnostics.Process]::Start($psi); $p.StandardInput.Close()
    $procs += ,@($i, $p, $null, $p.StandardOutput.ReadToEndAsync(), $p.StandardError.ReadToEndAsync())
  } catch { $procs += ,@($i, $null, $_.Exception.Message) }
}
$enc = [Text.Encoding]::UTF8
foreach ($e in $procs) {
  $i = $e[0]; $p = $e[1]
  if (-not $p) { $o = ''; $er = [string]$e[2]; $c = 127 }
  else { if (-not $p.WaitForExit(15000)) { try { $p.Kill() } catch {} ; $c = 124 } else { $c = $p.ExitCode }; $o = $e[3].Result; $er = $e[4].Result }
  [Console]::Out.WriteLine('${BATCH_MARK} ' + $i + ' ' + $c + ' ' + [Convert]::ToBase64String($enc.GetBytes([string]$o)) + ' ' + [Convert]::ToBase64String($enc.GetBytes([string]$er)))
}`;
  return psScript(script);
}

function parseBatchOutput(stdout, count) {
  const results = Array.from({ length: count }, () => null);
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.startsWith(BATCH_MARK)) continue;
    const [, indexText, codeText, out = '', err = ''] = line.split(' ');
    const index = Number(indexText);
    if (!Number.isInteger(index) || index < 0 || index >= count) continue;
    const status = Number(codeText);
    const decoded = (value) => Buffer.from(value, 'base64').toString('utf8').trim();
    results[index] = { status: Number.isInteger(status) ? status : null, stdout: decoded(out), stderr: decoded(err) };
  }
  return results;
}

function toProbeResult(raw) {
  if (!raw) return { ok: false, status: null, stdout: '', stderr: 'remote_probe_missing', value: '' };
  const ok = raw.status === 0;
  return { ok, status: raw.status, stdout: raw.stdout, stderr: raw.stderr, value: ok ? (raw.stdout || raw.stderr) : '' };
}

/** 命令批处理器：同一轮事件循环里的 exec 请求合并成一次远端执行。 */
function createCommandBatcher(machine, platform) {
  let queue = [];
  let scheduled = false;

  async function flush() {
    const items = queue;
    queue = [];
    scheduled = false;
    const { command, stdin } = platform === 'windows' ? buildWindowsBatch(items) : { command: buildPosixBatch(items) };
    try {
      const result = await machine.exec(command, { timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: 4 * 1024 * 1024, stdin });
      const parsed = parseBatchOutput(result.stdout, items.length);
      items.forEach((item, index) => item.resolve(toProbeResult(parsed[index])));
    } catch (error) {
      // 通道失败：本批所有探测都判「无法探测」（status=null → probeStatus=error），不冒充未安装。
      const failed = { ok: false, status: null, stdout: '', stderr: String(error && (error.code || error.message) || error), value: '' };
      items.forEach((item) => item.resolve(failed));
    }
  }

  return function execCommandAsync(command, args = []) {
    return new Promise((resolve) => {
      queue.push({ command: String(command), args: (args || []).map(String), resolve });
      if (!scheduled) {
        scheduled = true;
        setImmediate(() => { flush(); });
      }
    });
  };
}

function absolute(pathApi, home, value) {
  return pathApi.isAbsolute(value) ? value : pathApi.join(home, ...value.split('/'));
}

function snapshotScript(platform, home) {
  const windows = platform === 'windows';
  const pathApi = windows ? nodePath.win32 : nodePath.posix;
  const dirs = SNAPSHOT_DIRS.map((dir) => absolute(pathApi, home, dir));
  // Windows 已知路径（C:\\...）只在 Windows 上查，POSIX 路径只在 POSIX 上查；Windows 可执行文件补 .exe。
  const files = knownFilePaths()
    .filter((value) => (windows ? !value.startsWith('/') : !/^[A-Za-z]:\\/.test(value)))
    .flatMap((value) => {
      const full = absolute(pathApi, home, value);
      return windows && !/\.exe$/i.test(full) ? [`${full}.exe`, full] : [full];
    });
  if (windows) {
    return psScript(`foreach ($d in @(${dirs.map(psQuote).join(',')})) { if (Test-Path -LiteralPath $d -PathType Container) {`
      + ` $n = (Get-ChildItem -LiteralPath $d -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join '/';`
      + ` [Console]::Out.WriteLine('D' + [char]9 + $d + [char]9 + $n) } };`
      + ` foreach ($f in @(${files.map(psQuote).join(',')})) { if (Test-Path -LiteralPath $f -PathType Leaf) { [Console]::Out.WriteLine('F' + [char]9 + $f) } }`);
  }
  return `for d in ${dirs.map(shQuote).join(' ')}; do [ -d "$d" ] || continue; n=''; `
    + `for c in "$d"/*/ "$d"/.[!.]*/; do [ -d "$c" ] || continue; c=\${c%/}; n="$n/\${c##*/}"; done; `
    + `printf 'D\\t%s\\t%s\\n' "$d" "\${n#/}"; done; `
    + `for f in ${files.map(shQuote).join(' ')}; do [ -f "$f" ] && printf 'F\\t%s\\n' "$f"; done; true`;
  // POSIX 统一成 {command} 形状，与 Windows 的 psScript 对齐。
}

/**
 * 远端目录快照 → 同步 fs 视图（只实现 probe.js 用到的 existsSync / readdirSync）。
 * 快照之外的路径视为不存在：远端探测宁可少报，不能编造。
 */
async function snapshotFs(machine, platform, home) {
  const dirs = new Map();
  const files = new Set();
  try {
    const script = snapshotScript(platform, home);
    const { command, stdin } = typeof script === 'string' ? { command: script } : script;
    const result = await machine.exec(command, { timeoutMs: PROBE_TIMEOUT_MS, stdin });
    for (const line of result.stdout.split(/\r?\n/)) {
      const [tag, dir, names = ''] = line.split('\t');
      if (tag === 'F' && dir) { files.add(dir); continue; }
      if (tag !== 'D' || !dir) continue;
      dirs.set(dir, names ? names.split('/').filter(Boolean) : []);
    }
  } catch (_error) {
    // 拿不到快照：所有目录视为不存在。
  }
  const pathApi = platform === 'windows' ? nodePath.win32 : nodePath.posix;
  const norm = (value) => pathApi.normalize(String(value || ''));
  return {
    existsSync(target) {
      const key = norm(target);
      if (dirs.has(key) || files.has(key)) return true;
      const parent = pathApi.dirname(key);
      return Boolean(dirs.get(parent) && dirs.get(parent).includes(pathApi.basename(key)));
    },
    readdirSync(target, opts = {}) {
      const names = dirs.get(norm(target));
      if (!names) throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
      return opts.withFileTypes
        ? names.map((name) => ({ name, isDirectory: () => true }))
        : [...names];
    }
  };
}

/**
 * 生成「远端探测上下文」：交给 probe.js / resource-manager 的 options 补丁。
 * @param {import('../../../../remote-workspace/ops/remote-machine').RemoteMachine} machine
 * @returns {Promise<{platform, hostHomeDir, fs, path, execCommandAsync, processObj, env, remote: {os, arch}}>}
 */
async function createRemoteProbeOptions(machine) {
  const facts = await machine.profile();
  if (!facts.platform) {
    const error = new Error(`远端系统 ${facts.os} 不在 toolkit 支持范围（Linux / macOS / Windows）`);
    error.code = 'unsupported_platform';
    throw error;
  }
  const fs = await snapshotFs(machine, facts.platform, facts.home);
  const nodeLike = facts.platform === 'windows' ? 'win32' : facts.platform === 'macos' ? 'darwin' : 'linux';
  return {
    platform: facts.platform,
    hostHomeDir: facts.home,
    fs,
    path: facts.platform === 'windows' ? nodePath.win32 : nodePath.posix,
    execCommandAsync: createCommandBatcher(machine, facts.platform),
    // 本机进程信息绝不能漏进远端计划（例如本机的 SystemRoot / PATH）。
    processObj: { platform: nodeLike, env: {} },
    env: {},
    remote: { os: facts.os, arch: facts.arch }
  };
}

module.exports = {
  SNAPSHOT_DIRS,
  buildPosixBatch,
  buildWindowsBatch,
  createCommandBatcher,
  createRemoteProbeOptions,
  parseBatchOutput,
  snapshotFs
};
