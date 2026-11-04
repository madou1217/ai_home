'use strict';

// node:sqlite 首次使用会打一条 ExperimentalWarning。CLI 的 TUI（aih ls）把 stderr 直接
// 写进终端：多出来的这一行会让整屏下移，而增量重绘是按绝对行号定位的 —— 于是标题被
// 账号行覆盖、账号跑到别的 provider 分组下面（2026-11-04 真机事故）。
//
// 所以要在**每个**会碰 sqlite 的线程里装这道过滤：
//   * 主线程：bin/ai-home.js；
//   * worker / 垫片入口：account-enrich-worker、model-usage-{query,scan}-worker、
//     persistent-session-rows-worker、headless-runner-trampoline（新增入口照此办理）；
//   * 子进程（官方/第三方 CLI）：启动层统一注入 NODE_NO_WARNINGS=1
//     （见 lib/cli/services/pty/pty-runtime-spawn.js）；zcode app-server driver 另带
//     `--disable-warning=ExperimentalWarning`，覆盖不经过启动层的直接调用。

const SQLITE_EXPERIMENTAL_WARNING_RE = /SQLite is an experimental feature/i;

function isSqliteExperimentalWarning(warning, args = []) {
  const message = typeof warning === 'string'
    ? warning
    : String((warning && warning.message) || '');
  const type = typeof warning === 'string'
    ? String(args[0] || '')
    : String((warning && warning.name) || args[0] || '');
  return type === 'ExperimentalWarning' && SQLITE_EXPERIMENTAL_WARNING_RE.test(message);
}

function installSqliteWarningFilter(processObj) {
  const target = processObj || process;
  if (!target || typeof target.emitWarning !== 'function' || target.__aihSqliteWarningFiltered) {
    return target;
  }
  const originalEmitWarning = target.emitWarning.bind(target);
  target.emitWarning = function patchedEmitWarning(warning, ...args) {
    if (isSqliteExperimentalWarning(warning, args)) return;
    return originalEmitWarning(warning, ...args);
  };
  target.__aihSqliteWarningFiltered = true;
  return target;
}

module.exports = {
  SQLITE_EXPERIMENTAL_WARNING_RE,
  isSqliteExperimentalWarning,
  installSqliteWarningFilter
};
