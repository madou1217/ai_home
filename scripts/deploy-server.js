#!/usr/bin/env node
'use strict';

/**
 * 把 aih 的**二进制发行包**部署到远端（Linux / Windows），不再上传源码、不再远端 npm install。
 *
 * 产物就是 scripts/package/build-release.js 生成的单文件启动器：
 *   Linux   aih-<version>-<target>.run   （自带 Node + 依赖 + WebUI）
 *   Windows aih-<version>-<target>.exe
 *
 * 远端只做三件事：停旧服务 → 替换启动器 → 用新启动器重装/重启自启动单元。
 * 数据目录始终是远端 ~/.ai_home，部署不会碰它。
 *
 * 用法：
 *   node scripts/deploy-server.js --ssh ubuntu@host
 *   node scripts/deploy-server.js --ssh ubuntu@host --artifact dist/release/aih-1.0.0-linux-x64.run
 *   node scripts/deploy-server.js --ssh Administrator@winhost --target win32-x64
 *
 * 不传 --artifact 时，脚本会从 --ref 建临时 worktree 并现场构建目标平台的单文件包；
 * 传 --artifact 则直接使用 CI / 本机已经构建好的包。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULTS = Object.freeze({
  ref: 'origin/main',
  upload: 'rsync',
  unit: 'com.clawdcodex.ai_home',
  port: 9527,
  sshPort: 22,
  readyTimeoutSec: 60
});
const TARGETS = Object.freeze({
  'linux-x64': Object.freeze({ platform: 'linux', arch: 'x64', label: 'Linux x64' }),
  'linux-arm64': Object.freeze({ platform: 'linux', arch: 'arm64', label: 'Linux arm64' }),
  'win32-x64': Object.freeze({ platform: 'win32', arch: 'x64', label: 'Windows x64' }),
  'win32-arm64': Object.freeze({ platform: 'win32', arch: 'arm64', label: 'Windows arm64' }),
  'darwin-x64': Object.freeze({ platform: 'darwin', arch: 'x64', label: 'macOS Intel' }),
  'darwin-arm64': Object.freeze({ platform: 'darwin', arch: 'arm64', label: 'macOS Apple Silicon' })
});
const WINDOWS_ARCH = Object.freeze({ AMD64: 'x64', X86_64: 'x64', ARM64: 'arm64', AARCH64: 'arm64' });
const UNAME_OS = Object.freeze({ linux: 'linux', darwin: 'darwin' });
const UNAME_ARCH = Object.freeze({ x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' });

function showHelp() {
  console.log(`AIH binary deploy (single-file package, no source upload)

Usage:
  node scripts/deploy-server.js --ssh <user@host> [options]

Options:
  --ssh <user@host>       SSH target (required)
  --ssh-port <n>          SSH port, default ${DEFAULTS.sshPort}
  --ssh-key <pem>         SSH identity file
  --ref <git ref>         Pushed commit to build from, default ${DEFAULTS.ref}
  --artifact <path>       Prebuilt aih-<version>-<target>.run/.exe (skips the local build)
  --target <platform-arch> linux-x64 | linux-arm64 | win32-x64 | win32-arm64 | darwin-x64 | darwin-arm64
                          default: probe the remote (uname / cmd ver)
  --install-dir <path>    Where the aih launcher lives
                          Linux/macOS default: ~/.local/bin ; Windows default: %LOCALAPPDATA%\\aih
  --unit <name>           systemd user unit, default ${DEFAULTS.unit}
  --port <n>              Server port for the readiness check, default ${DEFAULTS.port}
  --upload <t>            Upload transport: ${Object.keys(UPLOAD_TRANSPORTS).join(' | ')}, default ${DEFAULTS.upload}
                          (Windows remotes always use scp)
  --web-dist <path>       Use a prebuilt web/dist when building locally
  --skip-go-build         Do not build Go Core into the package (Node still serves every route)
  --no-restart            Install the launcher only; do not touch the service
  --dry-run               Print the steps without changing anything
  --keep-work             Keep the temporary worktree used for the build
  -h, --help              Show this help`);
}

function parseArgs(argv, env = process.env) {
  const options = {
    ssh: '',
    sshKey: '',
    ...DEFAULTS,    artifact: '',
    target: '',
    installDir: '',
    webDist: '',
    skipGoBuild: false,
    restart: true,
    dryRun: false,
    keepWork: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--ssh') options.ssh = next();
    else if (arg === '--ssh-port') options.sshPort = Number(next());
    else if (arg === '--ssh-key') options.sshKey = next();
    else if (arg === '--ref') options.ref = next();
    else if (arg === '--artifact') options.artifact = next();
    else if (arg === '--target') options.target = next();
    else if (arg === '--install-dir' || arg === '--remote-dir') options.installDir = next();
    else if (arg === '--unit') options.unit = next();
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--upload') options.upload = next();
    else if (arg === '--web-dist') options.webDist = next();
    else if (arg === '--skip-go-build') options.skipGoBuild = true;
    else if (arg === '--no-restart') options.restart = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--keep-work') options.keepWork = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.help) {
    if (!options.ssh) options.ssh = String(env.AIH_DEPLOY_SSH || '').trim();
    if (!options.ssh) throw new Error('missing --ssh (or AIH_DEPLOY_SSH)');
    if (!Number.isInteger(options.sshPort) || options.sshPort < 1 || options.sshPort > 65535) throw new Error('invalid --ssh-port');
    if (!/^[A-Za-z0-9._-]+$/.test(options.unit)) throw new Error('invalid --unit');
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('invalid --port');
    if (options.target && !TARGETS[options.target]) throw new Error(`invalid --target (expected ${Object.keys(TARGETS).join('|')})`);
    if (!UPLOAD_TRANSPORTS[options.upload]) throw new Error(`invalid --upload (expected ${Object.keys(UPLOAD_TRANSPORTS).join('|')})`);
    if (options.installDir && !/^[~A-Za-z0-9._/:-]+$/.test(options.installDir)) throw new Error('invalid --install-dir');
    if (options.webDist && !fs.existsSync(path.resolve(options.webDist))) throw new Error('--web-dist does not exist');
  }
  return options;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Windows PowerShell 的 `-Command -` 按行执行 stdin，遇到多行 if/try/for 块会静默
// 什么都不做（退出码仍是 0）。部署脚本全是块结构，必须整段编码后一次性交给
// -EncodedCommand，才能保证脚本按一个整体执行并拿到真实退出码。
function encodePowerShellCommand(script) {
  return Buffer.from(String(script || ''), 'utf16le').toString('base64');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : (options.input ? ['pipe', 'inherit', 'inherit'] : 'inherit'),
    input: options.input,
    encoding: 'utf8'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0] || ''} failed with exit ${result.status}`);
  return options.capture ? String(result.stdout || '').trim() : '';
}

function sshArgs(options) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
    ...(options.sshPort && Number(options.sshPort) !== 22 ? ['-p', String(options.sshPort)] : []),
    ...(options.sshKey ? ['-i', options.sshKey.replace(/^~(?=\/)/, os.homedir())] : [])
  ];
}

// scp 的端口旗标是 -P（-p 在 scp 里是保留时间戳），不能复用 sshArgs。
function scpArgs(options) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
    ...(options.sshPort && Number(options.sshPort) !== 22 ? ['-P', String(options.sshPort)] : []),
    ...(options.sshKey ? ['-i', options.sshKey.replace(/^~(?=\/)/, os.homedir())] : [])
  ];
}

function sshCommandLine(options) {
  return ['ssh', ...sshArgs(options)]
    .map((token) => (/\s/.test(token) ? shQuote(token) : token))
    .join(' ');
}

let rsyncAppendFlagCache = '';
function rsyncAppendFlag() {
  if (rsyncAppendFlagCache) return rsyncAppendFlagCache;
  const probe = spawnSync('rsync', ['--version'], { encoding: 'utf8' });
  const text = `${probe.stdout || ''}${probe.stderr || ''}`;
  rsyncAppendFlagCache = /openrsync/i.test(text) ? '--append' : '--append-verify';
  return rsyncAppendFlagCache;
}

const UPLOAD_TRANSPORTS = Object.freeze({
  rsync: Object.freeze({
    name: 'rsync',
    label: 'rsync（断点续传）',
    command: 'rsync',
    resumable: true,
    maxAttempts: 20,
    args(options, localPath, remotePath) {
      return ['-q', '--partial', rsyncAppendFlag(), '-e', sshCommandLine(options), localPath, `${options.ssh}:${remotePath}`];
    }
  }),
  scp: Object.freeze({
    name: 'scp',
    label: 'scp（不续传）',
    command: 'scp',
    resumable: false,
    maxAttempts: 3,
    args(options, localPath, remotePath) {
      return ['-q', ...scpArgs(options), localPath, `${options.ssh}:${remotePath}`];
    }
  })
});

function isWindowsTarget(target) {
  return Boolean(target && target.platform === 'win32');
}

function targetKey(target) {
  return `${target.platform}-${target.arch}`;
}

function parseTarget(value) {
  const key = String(value || '').trim();
  return TARGETS[key] ? { ...TARGETS[key], key } : null;
}

function parseRemoteTarget(output) {
  const fields = String(output || '').trim().split(/\s+/);
  if (fields.length < 2) return null;
  const osName = fields[0].toLowerCase();
  if (/^(mingw|msys|cygwin)/.test(osName)) return parseTarget(`win32-${UNAME_ARCH[fields[1].toLowerCase()] || 'x64'}`);
  const platform = UNAME_OS[osName];
  const arch = UNAME_ARCH[fields[1].toLowerCase()];
  return platform && arch ? parseTarget(`${platform}-${arch}`) : null;
}

function probeRemoteTarget(options) {
  if (options.target) return parseTarget(options.target);
  try {
    const uname = run('ssh', [...sshArgs(options), options.ssh, 'uname -s -m'], { capture: true });
    const parsed = parseRemoteTarget(uname);
    if (parsed) return parsed;
  } catch (_error) { /* Windows OpenSSH 默认 shell 可能没有 uname */ }
  try {
    const ver = run('ssh', [...sshArgs(options), options.ssh, 'cmd /c ver'], { capture: true });
    if (/Microsoft Windows/i.test(ver)) {
      const archText = run('ssh', [...sshArgs(options), options.ssh, 'cmd /c echo %PROCESSOR_ARCHITECTURE%'], { capture: true });
      const arch = WINDOWS_ARCH[String(archText).trim().toUpperCase()] || 'x64';
      return parseTarget(`win32-${arch}`);
    }
  } catch (_error) { /* 交给下面的失败关闭 */ }
  throw new Error('cannot probe the remote target; pass --target <platform-arch>');
}

function inferTargetFromArtifact(file) {
  const name = path.basename(String(file || ''));
  const match = name.match(/^aih-(.+)-(linux|win32|darwin)-(x64|arm64)\.(run|exe)$/);
  if (!match) return null;
  return { target: parseTarget(`${match[2]}-${match[3]}`), version: match[1], extension: match[4] };
}

function defaultInstallDir(target) {
  return isWindowsTarget(target) ? '%LOCALAPPDATA%\\aih' : '~/.local/bin';
}

function resolveArtifactTarget(options, target) {
  const inferred = options.artifact ? inferTargetFromArtifact(options.artifact) : null;
  if (options.artifact) {
    if (!inferred) throw new Error('--artifact must be aih-<version>-<platform>-<arch>.run/.exe');
    if (inferred.target.key !== targetKey(target)) {
      throw new Error(`artifact target ${inferred.target.key} does not match deploy target ${targetKey(target)}`);
    }
    return inferred;
  }
  return null;
}

function readVersion(repositoryRoot) {
  return String(require(path.join(repositoryRoot, 'package.json')).version || '').trim();
}

function buildArtifact(options, sha, target) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-deploy-worktree-'));
  fs.rmSync(worktree, { recursive: true, force: true });
  run('git', ['worktree', 'add', '--detach', worktree, sha]);
  try {
    for (const link of ['node_modules', path.join('web', 'node_modules')]) {
      const source = path.join(REPO_ROOT, link);
      if (fs.existsSync(source)) fs.symlinkSync(source, path.join(worktree, link));
    }
    if (options.webDist) {
      fs.rmSync(path.join(worktree, 'web', 'dist'), { recursive: true, force: true });
      fs.cpSync(path.resolve(options.webDist), path.join(worktree, 'web', 'dist'), { recursive: true, force: true });
    }
    const version = readVersion(worktree);
    const outDir = path.join(worktree, 'dist', 'release');
    const args = [
      path.join(worktree, 'scripts', 'package', 'build-release.js'),
      '--targets', targetKey(target),
      '--out', outDir
    ];
    if (!options.skipGoBuild) args.push('--with-go');
    if (options.webDist) args.push('--skip-web-build');
    console.log(`[local] building ${version} for ${targetKey(target)} …`);
    run(process.execPath, args, { cwd: worktree });
    const suffix = isWindowsTarget(target) ? '.exe' : '.run';
    const built = path.join(outDir, `aih-${version}-${targetKey(target)}${suffix}`);
    if (!fs.existsSync(built)) throw new Error(`build did not produce ${built}`);
    const staged = path.join(os.tmpdir(), `aih-deploy-${sha.slice(0, 8)}-${process.pid}${suffix}`);
    fs.copyFileSync(built, staged);
    return { artifact: staged, version, target };
  } finally {
    for (const link of ['node_modules', path.join('web', 'node_modules')]) {
      try { fs.unlinkSync(path.join(worktree, link)); } catch (_error) { /* not created */ }
    }
    if (!options.keepWork) {
      spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: REPO_ROOT, stdio: 'ignore' });
      fs.rmSync(worktree, { recursive: true, force: true });
    } else {
      console.log(`[local] worktree kept: ${worktree}`);
    }
  }
}

function remoteArtifactPath(options, target, version) {
  const suffix = isWindowsTarget(target) ? '.exe' : '.run';
  const name = `aih-${version}-${targetKey(target)}${suffix}`;
  return isWindowsTarget(target) ? name : `/tmp/${name}`;
}

function remoteArtifactSize(options, remotePath, target) {
  if (isWindowsTarget(target)) {
    const output = run('ssh', [
      ...sshArgs(options), options.ssh,
      'powershell', '-NoProfile', '-Command',
      `if (Test-Path -LiteralPath ${psQuote(remotePath)}) { (Get-Item -LiteralPath ${psQuote(remotePath)}).Length } else { 0 }`
    ], { capture: true });
    return Number(String(output).trim()) || 0;
  }
  const output = run('ssh', [...sshArgs(options), options.ssh, `stat -c %s ${shQuote(remotePath)} 2>/dev/null || echo 0`], { capture: true });
  return Number(output) || 0;
}

function uploadArchive(options, localPath, remotePath, target) {
  const transport = UPLOAD_TRANSPORTS[options.upload];
  if (!transport) throw new Error(`unknown upload transport: ${options.upload}`);
  const expected = fs.statSync(localPath).size;
  for (let attempt = 1; ; attempt += 1) {
    let failure;
    try {
      run(transport.command, transport.args(options, localPath, remotePath));
      const actual = remoteArtifactSize(options, remotePath, target);
      if (actual === expected) return transport.name;
      failure = new Error(`uploaded size mismatch (local ${expected}, remote ${actual})`);
      if (!isWindowsTarget(target)) {
        run('ssh', [...sshArgs(options), options.ssh, `rm -f ${shQuote(remotePath)}`], { capture: true });
      }
    } catch (error) {
      failure = error;
    }
    if (attempt >= transport.maxAttempts) throw failure;
    const resume = transport.resumable ? '，从断点续传' : '';
    console.log(`[local] upload failed (${failure.message})${resume}, retrying ${attempt + 1}/${transport.maxAttempts} …`);
  }
}

function buildLinuxInstallScript(options, artifact, version, target) {
  const installDir = options.installDir || defaultInstallDir(target);
  const restart = options.restart;
  return `set -euo pipefail
ARTIFACT="$1"; VERSION="$2"; INSTALL_DIR="$3"; UNIT="$4"; PORT="$5"; RESTART="$6"
INSTALL_DIR="\${INSTALL_DIR/#~/$HOME}"
mkdir -p "$INSTALL_DIR"
chmod +x "$ARTIFACT"
PREV="$INSTALL_DIR/aih.prev"
if [ -x "$INSTALL_DIR/aih" ]; then
  cp -p "$INSTALL_DIR/aih" "$PREV" 2>/dev/null || true
  "$INSTALL_DIR/aih" server stop >/dev/null 2>&1 || true
fi
rollback() {
  trap - ERR
  if [ -f "$PREV" ]; then
    mv -f "$PREV" "$INSTALL_DIR/aih"
    systemctl --user restart "$UNIT" >/dev/null 2>&1 || true
  fi
}
trap rollback ERR
mv -f "$ARTIFACT" "$INSTALL_DIR/aih"
chmod 0755 "$INSTALL_DIR/aih"
echo "[remote] installed $INSTALL_DIR/aih ($VERSION)"
if [ "$RESTART" = "1" ]; then
  export AIH_CLI_PATH="$INSTALL_DIR/aih"
  export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  # 旧源码部署可能留下一个不属于本启动器的 9527 监听者；它会让 readyz 假通过。
  if command -v ss >/dev/null 2>&1; then
    STALE_PID=$(ss -ltnp "sport = :$PORT" 2>/dev/null | sed -n 's/.*pid=\\([0-9][0-9]*\\).*/\\1/p' | head -n 1)
    if [ -n "$STALE_PID" ]; then
      STALE_CMD=$(tr '\\0' ' ' < "/proc/$STALE_PID/cmdline" 2>/dev/null || true)
      case "$STALE_CMD" in
        *ai-home*|*aih*server*serve*) kill "$STALE_PID" 2>/dev/null || true; sleep 1 ;;
      esac
    fi
  fi
  "$INSTALL_DIR/aih" server autostart install
  systemctl --user restart "$UNIT"
  READY=0
  for _ in $(seq 1 ${options.readyTimeoutSec}); do
    if curl -fsS -m 3 "http://127.0.0.1:\${PORT}/readyz" 2>/dev/null | grep -q '"ok": *true'; then READY=1; break; fi
    sleep 1
  done
  echo "[remote] active=$(systemctl --user is-active "$UNIT") $(systemctl --user show "$UNIT" -p NRestarts)"
  if [ "$READY" != 1 ]; then echo "[remote] readyz did not answer ok" >&2; exit 4; fi
  echo "[remote] readyz ok"
fi
rm -f "$PREV"
trap - ERR
"$INSTALL_DIR/aih" help | head -n 1
`;
}

function buildWindowsInstallScript(options, artifact, version, target) {
  const installDir = options.installDir || defaultInstallDir(target);
  const restart = options.restart;
  return `$ErrorActionPreference = 'Stop'
$Artifact = ${psQuote(artifact)}
if (-not [System.IO.Path]::IsPathRooted($Artifact)) { $Artifact = Join-Path $env:USERPROFILE $Artifact }
$Version = ${psQuote(version)}
$InstallDir = ${psQuote(installDir)}.Replace('%LOCALAPPDATA%', $env:LOCALAPPDATA)
$Restart = ${restart ? '1' : '0'}
$Unit = ${psQuote(options.unit)}
$Port = ${options.port}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Target = Join-Path $InstallDir 'aih.exe'
if (Test-Path -LiteralPath $Target) {
  try { & $Target server stop 2>$null | Out-Null } catch {}
  Move-Item -Force -LiteralPath $Target -Destination "$Target.old"
}
Move-Item -Force -LiteralPath $Artifact -Destination $Target
Write-Output "[remote] installed $Target ($Version)"
if ($Restart -eq '1') {
  $env:AIH_CLI_PATH = $Target
  # 旧源码部署可能留下一个不属于本启动器的 9527 监听者；它会让 readyz 假通过。
  # 只清理占用本端口的非本启动器进程，避免新包“部署成功”但实际仍跑着旧代码。
  $Listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($Listener -and $Listener.OwningProcess) {
    $Owner = Get-Process -Id $Listener.OwningProcess -ErrorAction SilentlyContinue
    $OwnerPath = ''
    try { $OwnerPath = [string]$Owner.Path } catch {}
    if ($OwnerPath -and $OwnerPath -ne $Target) {
      Stop-Process -Id $Listener.OwningProcess -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
    }
  }
  & $Target server autostart install | Out-Null
  # SSH / 计划任务的子进程会随会话结束被杀；WMI 创建的进程挂在 WmiPrvSE 下，
  # 断开 SSH 后仍然存活，这是远程启动 Windows 服务的确定做法。
  $ServeCommand = '"' + $Target + '" server serve --host 127.0.0.1 --port ' + $Port
  $Created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $ServeCommand }
  if ($Created.ReturnValue -ne 0) { throw "[remote] could not start the packaged server (Win32_Process=$($Created.ReturnValue))" }
  $Ready = 0
  for ($i = 0; $i -lt ${options.readyTimeoutSec}; $i += 1) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$Port/readyz"
      if ($response.Content -match '"ok"\\s*:\\s*true') { $Ready = 1; break }
    } catch {}
    Start-Sleep -Seconds 1
  }
  if ($Ready -ne 1) { throw '[remote] readyz did not answer ok' }
  Write-Output '[remote] readyz ok'
}
& $Target help | Out-Null
Write-Output '[remote] launcher ok'
exit 0
`;
}

function resolveDeployTarget(options) {
  if (options.target) return probeRemoteTarget(options);
  if (options.dryRun && options.artifact) {
    const inferred = inferTargetFromArtifact(options.artifact);
    if (!inferred) throw new Error('--artifact must be aih-<version>-<platform>-<arch>.run/.exe');
    return inferred.target;
  }
  return probeRemoteTarget(options);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return;
  }
  const target = resolveDeployTarget(options);
  if (isWindowsTarget(target) && options.upload !== 'scp') options.upload = 'scp';

  let sha = '';
  if (!options.artifact) {
    if (options.ref.startsWith('origin/')) run('git', ['fetch', '--quiet', 'origin']);
    sha = run('git', ['rev-parse', '--verify', `${options.ref}^{commit}`], { capture: true });
    const pushed = run('git', ['branch', '-r', '--contains', sha], { capture: true });
    if (!pushed) throw new Error(`${options.ref} (${sha.slice(0, 8)}) is not on any pushed branch; push it first`);
  }

  const inferred = resolveArtifactTarget(options, target);
  const resolved = options.artifact
    ? { artifact: path.resolve(options.artifact), version: inferred.version, target }
    : buildArtifact(options, sha, target);
  const remoteArtifact = remoteArtifactPath(options, target, resolved.version);
  const script = isWindowsTarget(target)
    ? buildWindowsInstallScript(options, remoteArtifact, resolved.version, target)
    : buildLinuxInstallScript(options, remoteArtifact, resolved.version, target);

  console.log(`[local] deploying ${resolved.version} (${targetKey(target)}) to ${options.ssh}`);
  console.log(`[local] artifact: ${resolved.artifact} (${(fs.statSync(resolved.artifact).size / 1024 / 1024).toFixed(1)} MB)`);
  if (options.dryRun) {
    console.log(`[dry-run] would upload to ${remoteArtifact} via ${UPLOAD_TRANSPORTS[options.upload].label} and run:\n${script}`);
    if (!options.artifact) fs.rmSync(resolved.artifact, { force: true });
    return;
  }

  try {
    const transport = UPLOAD_TRANSPORTS[options.upload];
    console.log(`[local] uploading via ${transport.label}`);
    uploadArchive(options, resolved.artifact, remoteArtifact, target);
    if (isWindowsTarget(target)) {
      run('ssh', [
        ...sshArgs(options), options.ssh,
        'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodePowerShellCommand(script)
      ]);
    } else {
      run('ssh', [
        ...sshArgs(options), options.ssh,
        'bash', '-s', '--', remoteArtifact, resolved.version,
        options.installDir || defaultInstallDir(target), options.unit, String(options.port),
        options.restart ? '1' : '0'
      ], { input: script });
    }
    console.log(`[local] deployed ${resolved.version} (${targetKey(target)})`);
  } finally {
    if (!options.artifact) fs.rmSync(resolved.artifact, { force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`deploy failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULTS,
  TARGETS,
  UPLOAD_TRANSPORTS,
  buildLinuxInstallScript,
  buildWindowsInstallScript,
  encodePowerShellCommand,
  inferTargetFromArtifact,
  isWindowsTarget,
  parseArgs,
  parseRemoteTarget,
  parseTarget,
  remoteArtifactPath,
  resolveDeployTarget,
  rsyncAppendFlag,
  scpArgs,
  shQuote,
  sshArgs,
  targetKey,
  uploadArchive
};

