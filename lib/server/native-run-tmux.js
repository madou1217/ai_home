'use strict';

// webUI native run 的 tmux 执行层：让 CLI 进程的生命周期与 server 进程彻底脱钩。
//
// 设计（与 CLI 持久会话的 per-account socket 不同）：**每个 run 一个独立 tmux socket**
// （aih-run-<runId 前缀>）。理由：webUI 并发 run 来自不同 provider/账号，env（凭据）互不相同,
// 而 tmux 的 pane env 继承自「tmux server 首次启动时的 env」——独立 socket = 每 run 自带
// 正确 env、互不污染；abort = kill-server 一锅端无殃及；has-session 判活也最简单。
// 凭据只经 env 传递（spawn tmux 客户端时带 provider env → 新 tmux server 继承），argv 里
// 只有 CLI 参数与日志路径，ps 看不到密钥（与项目既有约定一致）。
//
// systemd 逃逸：aih-server 作为 systemd user service 跑时（AWS），直接 spawn 的 tmux server
// 会落在 service 的 cgroup 里、restart 时被连坐杀掉。检测到 systemd-run 可用时用
// `systemd-run --user --scope` 包一层：tmux server 进独立 transient scope，restart 不再波及
// （已在 AWS 实测通过）。--scope 模式下命令继承调用方 env，凭据传递不受影响。
// 本地（mac/手动启动）没有 cgroup 连坐问题,普通 spawn 即可。

const { spawnSync } = require('node:child_process');
const nodeFs = require('node:fs');
const path = require('node:path');

const RUN_EXIT_MARKER = '__AIH_RUN_EXIT:';
const RUN_SESSION_NAME = 'run';

function quote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "'\\''")}'`;
}

let cachedTmuxSupported = null;
function isTmuxRunSupported(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') return false;
  if (typeof options.forceSupported === 'boolean') return options.forceSupported;
  if (cachedTmuxSupported !== null) return cachedTmuxSupported;
  const spawnImpl = options.spawnSyncImpl || spawnSync;
  try {
    cachedTmuxSupported = spawnImpl('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
  } catch (_error) {
    cachedTmuxSupported = false;
  }
  return cachedTmuxSupported;
}

let cachedSystemdRunSupported = null;
function isSystemdScopeSupported(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (platform !== 'linux' || !String(env.XDG_RUNTIME_DIR || '').trim()) return false;
  if (cachedSystemdRunSupported !== null) return cachedSystemdRunSupported;
  const spawnImpl = options.spawnSyncImpl || spawnSync;
  try {
    cachedSystemdRunSupported = spawnImpl('systemd-run', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch (_error) {
    cachedSystemdRunSupported = false;
  }
  return cachedSystemdRunSupported;
}

function socketForRun(runId) {
  const compact = String(runId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'unknown';
  return `aih-run-${compact}`;
}

// 组装在 tmux pane 里执行的 shell 命令：整体（含管道,如 claude 图片 cat-pipe）重定向到日志,
// 结束后追加退出标记行——tail 端据此确定性拿到完成信号与退出码,无需轮询进程。
function buildRunShellCommand(innerShellCommand, logPath) {
  const qlog = quote(logPath);
  return `{ ${innerShellCommand} ; } > ${qlog} 2>&1; printf '\\n${RUN_EXIT_MARKER}%s\\n' "$?" >> ${qlog}`;
}

// argv 数组 → 单条安全 shell 命令（无管道的常规 CLI 调用用它;claude 图片分支自带 sh 命令串）。
function buildInnerCommandFromArgv(command, args = []) {
  return [command, ...args].map(quote).join(' ');
}

function buildTmuxArgs(socket, subcommand) {
  return ['-L', String(socket), ...subcommand];
}

function spawnDetachedTmuxRun(options = {}) {
  const spawnImpl = options.spawnSyncImpl || spawnSync;
  const socket = String(options.socket || '').trim();
  const shellCommand = String(options.shellCommand || '').trim();
  if (!socket || !shellCommand) {
    return { ok: false, error: 'tmux_run_invalid_options' };
  }
  const tmuxArgv = buildTmuxArgs(socket, [
    'new-session', '-d', '-s', RUN_SESSION_NAME,
    ...(options.cwd ? ['-c', String(options.cwd)] : []),
    '--', 'sh', '-c', shellCommand
  ]);
  const useScope = options.useSystemdScope !== false && isSystemdScopeSupported(options);
  const argv = useScope
    ? ['systemd-run', '--user', '--scope', '--collect', '-q', '--', 'tmux', ...tmuxArgv]
    : ['tmux', ...tmuxArgv];
  const result = spawnImpl(argv[0], argv.slice(1), {
    env: options.env || process.env,
    stdio: 'ignore'
  });
  if (result.status !== 0) {
    // scope 包装失败（如非 systemd 环境误判）时降级裸 tmux 再试一次。
    if (useScope) {
      const fallback = spawnImpl('tmux', tmuxArgv, { env: options.env || process.env, stdio: 'ignore' });
      if (fallback.status === 0) return { ok: true, socket, session: RUN_SESSION_NAME, scoped: false };
    }
    return { ok: false, error: `tmux_spawn_failed_status_${result.status}` };
  }
  return { ok: true, socket, session: RUN_SESSION_NAME, scoped: useScope };
}

function hasRunSession(socket, options = {}) {
  const spawnImpl = options.spawnSyncImpl || spawnSync;
  try {
    return spawnImpl('tmux', buildTmuxArgs(socket, ['has-session', '-t', RUN_SESSION_NAME]), { stdio: 'ignore' }).status === 0;
  } catch (_error) {
    return false;
  }
}

function killRunServer(socket, options = {}) {
  const spawnImpl = options.spawnSyncImpl || spawnSync;
  try {
    spawnImpl('tmux', buildTmuxArgs(socket, ['kill-server']), { stdio: 'ignore' });
  } catch (_error) { /* server 已不在即目的达成 */ }
}

// run 结束后的彻底清理：kill-server(活着则杀,死了是 no-op) + 摘掉残留 socket 文件
// （tmux server 自然退出(exit-empty)时偶尔留下 0 字节 socket,积少成多污染 /tmp）。
function runSocketPath(socket, options = {}) {
  const env = options.env || process.env;
  const base = String(env.TMUX_TMPDIR || '').trim() || '/tmp';
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(base, `tmux-${uid}`, String(socket));
}

function cleanupRunSocket(socket, options = {}) {
  if (!String(socket || '').trim()) return;
  killRunServer(socket, options);
  const fs = options.fs || nodeFs;
  try { fs.unlinkSync(runSocketPath(socket, options)); } catch (_error) { /* 已清/不存在 */ }
}

function sendRunKeys(socket, text, options = {}) {
  const spawnImpl = options.spawnSyncImpl || spawnSync;
  const value = String(text == null ? '' : text);
  if (value) {
    const sent = spawnImpl('tmux', buildTmuxArgs(socket, ['send-keys', '-t', RUN_SESSION_NAME, '-l', '--', value]), { stdio: 'ignore' });
    if (sent.status !== 0) return false;
  }
  if (options.appendNewline !== false) {
    return spawnImpl('tmux', buildTmuxArgs(socket, ['send-keys', '-t', RUN_SESSION_NAME, 'Enter']), { stdio: 'ignore' }).status === 0;
  }
  return true;
}

module.exports = {
  RUN_EXIT_MARKER,
  RUN_SESSION_NAME,
  isTmuxRunSupported,
  isSystemdScopeSupported,
  socketForRun,
  buildRunShellCommand,
  buildInnerCommandFromArgv,
  spawnDetachedTmuxRun,
  hasRunSession,
  killRunServer,
  cleanupRunSocket,
  sendRunKeys
};
