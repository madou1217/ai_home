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

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULTS = Object.freeze({
  ref: 'origin/main',
  remoteDir: '~/ai_home',
  unit: 'aih-server',
  port: 9527,
  readyTimeoutSec: 60
});
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
  --skip-web-build       Reuse the web/dist committed state (no local web build)
  --no-restart           Update files only
  --dry-run              Print the steps without changing anything
  -h, --help             Show this help`);
}

function parseArgs(argv, env = process.env) {
  const options = {
    ssh: String(env.AIH_DEPLOY_SSH || '').trim(),
    sshKey: String(env.AIH_DEPLOY_SSH_KEY || '').trim(),
    ...DEFAULTS,
    skipWebBuild: false,
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
    else if (arg === '--skip-web-build') options.skipWebBuild = true;
    else if (arg === '--no-restart') options.restart = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.help) {
    if (!options.ssh) throw new Error('missing --ssh (or AIH_DEPLOY_SSH)');
    if (!/^[A-Za-z0-9._-]+$/.test(options.unit)) throw new Error('invalid --unit');
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('invalid --port');
    if (!/^[~A-Za-z0-9._/-]+$/.test(options.remoteDir)) throw new Error('invalid --remote-dir');
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
  const preserved = REMOTE_PRESERVED.map((item) => `--exclude ${shQuote(`/${item}`)}`).join(' ');
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
    console.log(`[dry-run] would build ${options.skipWebBuild ? 'without' : 'with'} web build, upload to ${remoteArchive} and run:\n${remoteScript}`);
    return;
  }

  const archive = buildLocalArchive(options, sha);
  try {
    console.log(`[local] uploading ${(fs.statSync(archive).size / 1024 / 1024).toFixed(1)} MB`);
    run('scp', ['-q', ...sshArgs(options), archive, `${options.ssh}:${remoteArchive}`]);
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
  TAR_EXCLUDES,
  buildRemoteScript,
  parseArgs,
  remotePath,
  shQuote
};
