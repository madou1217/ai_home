#!/usr/bin/env node
'use strict';

/**
 * 把已推送的提交部署到远端 aih server（单目录原地更新）。
 *
 * 远端布局：代码 <remote-dir>（默认 ~/ai_home，内含 node_modules、.node-runtime、data），
 * 数据 ~/.ai_home；systemd user 单元负责启停。不创建任何版本目录或缓存目录。
 *
 * 流程：
 *   1. 本机从 <ref>（默认 origin/main）建临时 worktree，构建前端，打包（不含 .git / node_modules），
 *      从不打包工作区——工作区里可能有其它会话未提交的改动。
 *   2. 远端解到临时目录 → 依赖有变化则在临时目录安装 → 用远端 node 预检加载 → 通过后才
 *      rsync --delete 覆盖代码（保留 node_modules / .node-runtime / data）、原子替换 node_modules。
 *   3. 重启服务，轮询 /readyz，检查崩溃重启次数；临时文件全部清理。
 *
 * 用法：
 *   node scripts/deploy-server.js --ssh ubuntu@host --ssh-key ~/.ssh/key.pem
 *   （也可用环境变量 AIH_DEPLOY_SSH / AIH_DEPLOY_SSH_KEY；--dry-run 只打印步骤）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildGoServer } = require('./build-go-server');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULTS = Object.freeze({
  ref: 'origin/main',
  remoteDir: '~/ai_home',
  unit: 'aih-server',
  port: 9527,
  readyTimeoutSec: 60
});
// 远端 uname 到 Go 构建目标的映射。部署到错平台的二进制会让 Go Core 永远起不来，
// 因此默认按远端真实平台交叉编译，而不是假定 linux-x64。
const GOOS_BY_UNAME = Object.freeze({ linux: 'linux', darwin: 'darwin' });
const GOARCH_BY_UNAME = Object.freeze({ x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' });
const TAR_EXCLUDES = Object.freeze([
  './.git',
  './node_modules',
  './web/node_modules',
  './web/src/.umi',
  './web/src/.umi-production',
  '._*',
  '.DS_Store'
]);
// 远端保留、不随代码同步的路径（相对 remote-dir）。
const REMOTE_PRESERVED = Object.freeze(['node_modules', '.node-runtime', 'data', 'DEPLOYED_GIT_HEAD']);
// 跳过 Go 构建时必须一并保留远端 bin/native：`rsync --delete` 会在归档里没有该目录时
// 删掉远端正在运行的 Go 二进制，服务随后起不来。
const REMOTE_PRESERVED_WITHOUT_GO = Object.freeze([...REMOTE_PRESERVED, 'bin/native']);

/** 按本次运行是否携带 Go 构件，决定 rsync 的保留名单。 */
function remotePreserved(options = {}) {
  return options.skipGoBuild ? REMOTE_PRESERVED_WITHOUT_GO : REMOTE_PRESERVED;
}

/**
 * 把远端 `uname -s -m` 的输出解析成 Go 构建目标。
 *
 * 认不出来（含 Windows 的 MINGW/MSYS/CYGWIN 与未知架构）时返回 null，由调用方失败关闭：
 * 宁可不部署，也不能把一个错平台的二进制推上去。
 */
function parseRemoteGoTarget(output) {
  const fields = String(output || '').trim().split(/\s+/);
  if (fields.length < 2) return null;
  const osName = fields[0].toLowerCase();
  const goos = osName.startsWith('mingw') || osName.startsWith('msys') || osName.startsWith('cygwin')
    ? 'windows'
    : GOOS_BY_UNAME[osName];
  const goarch = GOARCH_BY_UNAME[fields[1].toLowerCase()];
  return goos && goarch ? { platform: goos === 'windows' ? 'win32' : goos, arch: goarch } : null;
}

function showHelp() {
  console.log(`AIH server deploy (single directory, in place)

Usage:
  node scripts/deploy-server.js --ssh <user@host> [--ssh-key <pem>] [options]

Options:
  --ssh <user@host>      SSH target (or AIH_DEPLOY_SSH)
  --ssh-key <pem>        SSH identity file (or AIH_DEPLOY_SSH_KEY)
  --ref <git ref>        Pushed commit to deploy, default ${DEFAULTS.ref}
  --remote-dir <path>    Remote code directory, default ${DEFAULTS.remoteDir}
  --unit <name>          systemd user unit, default ${DEFAULTS.unit}
  --port <n>             Server port for the readiness check, default ${DEFAULTS.port}
  --go-target <t>        Go Core build target <platform>-<arch>, default: probe the remote
                         (linux-x64 / linux-arm64 / win32-x64 / darwin-arm64)
  --skip-web-build       Reuse the web/dist committed state (no local web build)
  --skip-go-build        Do not cross-compile Go Core; keep the remote bin/native as is
  --no-restart           Update files only
  --dry-run              Print the steps without changing anything
  -h, --help             Show this help`);
}

function parseArgs(argv, env = process.env) {
  const options = {
    ssh: String(env.AIH_DEPLOY_SSH || '').trim(),
    sshKey: String(env.AIH_DEPLOY_SSH_KEY || '').trim(),
    ...DEFAULTS,
    goTarget: String(env.AIH_DEPLOY_GO_TARGET || '').trim(),
    skipWebBuild: false,
    skipGoBuild: false,
    restart: true,
    dryRun: false,
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
    else if (arg === '--ssh-key') options.sshKey = next();
    else if (arg === '--ref') options.ref = next();
    else if (arg === '--remote-dir') options.remoteDir = next();
    else if (arg === '--unit') options.unit = next();
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--go-target') options.goTarget = next();
    else if (arg === '--skip-web-build') options.skipWebBuild = true;
    else if (arg === '--skip-go-build') options.skipGoBuild = true;
    else if (arg === '--no-restart') options.restart = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.help) {
    if (!options.ssh) throw new Error('missing --ssh (or AIH_DEPLOY_SSH)');
    if (!/^[A-Za-z0-9._-]+$/.test(options.unit)) throw new Error('invalid --unit');
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('invalid --port');
    if (!/^[~A-Za-z0-9._/-]+$/.test(options.remoteDir)) throw new Error('invalid --remote-dir');
    if (options.goTarget && !/^[a-z0-9]+-[a-z0-9]+$/.test(options.goTarget)) throw new Error('invalid --go-target');
    if (options.goTarget && options.skipGoBuild) throw new Error('--go-target and --skip-go-build are mutually exclusive');
  }
  return options;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// 远端路径里的 ~ 交给远端 shell 展开（只允许出现在开头）。
function remotePath(value) {
  const text = String(value);
  return text.startsWith('~/') ? `"$HOME"/${shQuote(text.slice(2))}` : shQuote(text);
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
    ...(options.sshKey ? ['-i', options.sshKey.replace(/^~(?=\/)/, os.homedir())] : [])
  ];
}

/**
 * 远端执行脚本（经 ssh 的 stdin 交给 bash -s）。参数只经 bash 位置参数传入，
 * 不使用 pkill -f / pgrep -f：它们会匹配到 ssh 会话自己的命令行而把会话杀掉。
 */
function buildRemoteScript(options) {
  const preserved = remotePreserved(options).map((item) => `--exclude ${shQuote(`/${item}`)}`).join(' ');
  return `set -euo pipefail
ARCHIVE="$1"; SHA="$2"
DIR=${remotePath(options.remoteDir)}
NODE_BIN="$DIR/.node-runtime/node-v22.16.0-linux-x64/bin"
if [ ! -x "$NODE_BIN/node" ]; then NODE_BIN="$(dirname "$(ls -d "$DIR"/.node-runtime/*/bin/node 2>/dev/null | head -n1)")"; fi
if [ ! -x "$NODE_BIN/node" ]; then echo "remote node runtime missing under $DIR/.node-runtime" >&2; rm -f "$ARCHIVE"; exit 2; fi
STAGE="$(mktemp -d "\${TMPDIR:-/tmp}/aih-deploy.XXXXXX")"
cleanup() { rm -rf "$STAGE" "$ARCHIVE"; }
trap cleanup EXIT
tar -xzf "$ARCHIVE" -C "$STAGE"
echo "[remote] previous: $(cat "$DIR/DEPLOYED_GIT_HEAD" 2>/dev/null || echo unknown)"

DEPS_CHANGED=0
# 只看运行时依赖是否变化（scripts 等字段变化不需要重装）。
if [ ! -d "$DIR/node_modules" ] || [ ! -f "$DIR/package.json" ] || ! "$NODE_BIN/node" -e "
  const pick = (file) => { const p = require(file); return JSON.stringify([p.dependencies || {}, p.optionalDependencies || {}]); };
  process.exit(pick(process.argv[1]) === pick(process.argv[2]) ? 0 : 1);
" "$STAGE/package.json" "$DIR/package.json"; then DEPS_CHANGED=1; fi
if [ "$DEPS_CHANGED" = 1 ]; then
  echo "[remote] dependencies changed -> npm install in staging"
  (cd "$STAGE" && PATH="$NODE_BIN:$PATH" npm install --ignore-scripts --omit=dev --no-audit --no-fund --loglevel=error)
else
  ln -s "$DIR/node_modules" "$STAGE/node_modules"
fi

echo "[remote] preflight load"
if ! PREFLIGHT="$(cd "$STAGE" && "$NODE_BIN/node" -e "require('./lib/server/server.js');require('./lib/server/web-ui-router.js')" 2>&1)"; then
  echo "$PREFLIGHT" | tail -n 20 >&2
  echo "[remote] preflight failed; nothing changed" >&2
  exit 3
fi

echo "[remote] sync code -> $DIR"
rsync -a --delete ${preserved} "$STAGE"/ "$DIR"/
if [ "$DEPS_CHANGED" = 1 ]; then
  rm -rf "$DIR/node_modules.next" "$DIR/node_modules.prev"
  mv "$STAGE/node_modules" "$DIR/node_modules.next"
  if [ -d "$DIR/node_modules" ]; then mv "$DIR/node_modules" "$DIR/node_modules.prev"; fi
  mv "$DIR/node_modules.next" "$DIR/node_modules"
  rm -rf "$DIR/node_modules.prev"
fi
echo "$SHA" > "$DIR/DEPLOYED_GIT_HEAD"

${options.restart ? `export XDG_RUNTIME_DIR="/run/user/$(id -u)"
echo "[remote] restart ${options.unit}"
systemctl --user restart ${shQuote(options.unit)}
READY=0
for _ in $(seq 1 ${options.readyTimeoutSec}); do
  if curl -fsS -m 3 "http://127.0.0.1:${options.port}/readyz" 2>/dev/null | grep -q '"ok": *true'; then READY=1; break; fi
  sleep 1
done
echo "[remote] active=$(systemctl --user is-active ${shQuote(options.unit)}) $(systemctl --user show ${shQuote(options.unit)} -p NRestarts)"
if [ "$READY" != 1 ]; then echo "[remote] readyz did not answer ok" >&2; exit 4; fi
echo "[remote] readyz ok"` : 'echo "[remote] restart skipped (--no-restart)"'}
echo "[remote] deployed: $SHA"
`;
}

/**
 * 解析本次部署要交叉编译的 Go 目标。
 *
 * 显式 `--go-target` 优先；否则探测远端真实平台。探测失败一律失败关闭——猜一个平台
 * 会把起不来的二进制推上去，而带上一个空 bin/native 的归档会顺带删掉远端现有的那个。
 */
function resolveGoTarget(options) {
  if (options.goTarget) {
    const [platform, arch] = options.goTarget.split('-');
    return { platform, arch };
  }
  let output = '';
  try {
    output = run('ssh', [...sshArgs(options), options.ssh, 'uname -s -m'], { capture: true });
  } catch (error) {
    throw new Error(`cannot probe the remote Go target (${error.message}); pass --go-target <platform>-<arch> or --skip-go-build`);
  }
  const target = parseRemoteGoTarget(output);
  if (!target) {
    throw new Error(`unsupported remote Go target ${JSON.stringify(output.trim())}; pass --go-target <platform>-<arch> or --skip-go-build`);
  }
  return target;
}

function buildLocalArchive(options, sha) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-deploy-worktree-'));
  const archive = path.join(os.tmpdir(), `aih-deploy-${sha.slice(0, 8)}-${process.pid}.tgz`);
  fs.rmSync(worktree, { recursive: true, force: true });
  run('git', ['worktree', 'add', '--detach', worktree, sha]);
  try {
    if (!options.skipWebBuild) {
      fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(worktree, 'node_modules'));
      fs.symlinkSync(path.join(REPO_ROOT, 'web', 'node_modules'), path.join(worktree, 'web', 'node_modules'));
      console.log('[local] building web …');
      run('npx', ['max', 'build'], { cwd: path.join(worktree, 'web'), capture: true });
    }
    if (!options.skipGoBuild) {
      // bin/native 是 gitignore 的，worktree 里本来就没有：必须在这里产出远端平台的
      // 二进制，否则归档不带 Go Core，远端只能继续跑旧的（或什么都没有）。
      const target = resolveGoTarget(options);
      console.log(`[local] building Go Core for ${target.platform}-${target.arch} …`);
      const built = buildGoServer({ repositoryRoot: worktree, platform: target.platform, arch: target.arch });
      console.log(`[local] Go Core: ${path.relative(worktree, built.output)} (sha256 ${built.stamp.binary_sha256.slice(0, 12)})`);
    } else {
      console.log('[local] Go Core build skipped; the remote bin/native is preserved');
    }
    run('tar', [
      '--format', 'ustar', '--no-xattrs',
      ...TAR_EXCLUDES.flatMap((item) => ['--exclude', item]),
      '-czf', archive, '.'
    ], { cwd: worktree, env: { COPYFILE_DISABLE: '1' } });
    return archive;
  } finally {
    for (const link of ['node_modules', path.join('web', 'node_modules')]) {
      try { fs.unlinkSync(path.join(worktree, link)); } catch (_error) { /* not created */ }
    }
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: REPO_ROOT, stdio: 'ignore' });
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return;
  }
  if (options.ref.startsWith('origin/')) run('git', ['fetch', '--quiet', 'origin']);
  const sha = run('git', ['rev-parse', '--verify', `${options.ref}^{commit}`], { capture: true });
  const pushed = run('git', ['branch', '-r', '--contains', sha], { capture: true });
  if (!pushed) throw new Error(`${options.ref} (${sha.slice(0, 8)}) is not on any pushed branch; push it first`);
  console.log(`[local] deploying ${sha.slice(0, 8)} (${options.ref}) to ${options.ssh}:${options.remoteDir}`);

  const remoteScript = buildRemoteScript(options);
  const remoteArchive = `/tmp/aih-deploy-${sha.slice(0, 8)}.tgz`;
  if (options.dryRun) {
    const go = options.skipGoBuild
      ? 'keeping the remote bin/native'
      : `cross-compiling Go Core for ${options.goTarget || 'the probed remote target'}`;
    console.log(`[dry-run] would build ${options.skipWebBuild ? 'without' : 'with'} web build, ${go}, upload to ${remoteArchive} and run:\n${remoteScript}`);
    return;
  }

  const archive = buildLocalArchive(options, sha);
  try {
    console.log(`[local] uploading ${(fs.statSync(archive).size / 1024 / 1024).toFixed(1)} MB`);
    // 上传可安全重试（覆盖同名临时文件）；远端执行不重试，失败由预检/回报决定。
    for (let attempt = 1; ; attempt += 1) {
      try {
        run('scp', ['-q', ...sshArgs(options), archive, `${options.ssh}:${remoteArchive}`]);
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
        console.log(`[local] upload failed (${error.message}), retrying ${attempt + 1}/3 …`);
      }
    }
    run('ssh', [...sshArgs(options), options.ssh, 'bash', '-s', '--', remoteArchive, sha], { input: remoteScript });
  } finally {
    fs.rmSync(archive, { force: true });
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
  REMOTE_PRESERVED,
  REMOTE_PRESERVED_WITHOUT_GO,
  TAR_EXCLUDES,
  buildRemoteScript,
  parseArgs,
  parseRemoteGoTarget,
  remotePath,
  remotePreserved,
  shQuote
};
