'use strict';

const { ensureZcodeSharedSessionState } = require('./zcode-shared-session-store');

/**
 * ZCode launch isolation.
 *
 * ZCode reads all shared state (credentials, provider registry, sessions) from
 * one data root selected by ZCODE_DATA_BASE_DIR. Pointing it at the per-account
 * sandbox `.zcode` gives OAuth accounts credential isolation, while
 * `zcode-shared-session-store` links the conversation/project state
 * (tasks-index, sessions, cli/, workspace/) back into the host `~/.zcode`
 * so every account's client sees the same sessions.
 *
 * API-key accounts additionally receive ZCODE_API_KEY through the provider
 * runtime env passthrough; the projected `v2/config.json` carries the endpoint.
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

/**
 * ZCode resolves the data root before loading configuration; ensure the
 * strategy-owned directory exists for new login projections as well as normal
 * account launches, then bridge the shareable session state into the host
 * store. Linking is best-effort: a failure must never block a launch.
 *
 * @param {SandboxLaunchContext & {fs?: any}} ctx
 */
function prepare(ctx) {
  const fs = ctx && ctx.fs;
  const dataBaseDir = String(ctx && ctx.zcodeDataBaseDir || '').trim();
  if (dataBaseDir && fs && typeof fs.mkdirSync === 'function') {
    fs.mkdirSync(dataBaseDir, { recursive: true });
  }
  ensureZcodeSharedSessionState({
    fs,
    path: ctx && ctx.path,
    sandboxDir: ctx && ctx.sandboxDir,
    hostHomeDir: ctx && ctx.hostHomeDir
  });
}

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  const { sandboxDir, path } = ctx;
  const explicit = String(ctx && ctx.zcodeDataBaseDir || '').trim();
  // ZCODE_DATA_BASE_DIR 是**基目录**，不是数据目录：CLI 自己再拼 `.zcode/v2/…`
  // （bundle 实测 `dataBaseDir = env.ZCODE_DATA_BASE_DIR ?? homedir()`，随后
  // `join(base, '.zcode', 'v2', …)`；`NWs()` 只做 `~` 展开与规范化，**不会**剥掉
  // 尾部的 `.zcode`）。桌面端策略同样把 profileDir 当基目录
  // （lib/server/desktop-launch/zcode-strategy.js），两者必须一致。
  // 曾把 `<sandbox>/.zcode` 当基目录 → CLI 落到 `<sandbox>/.zcode/.zcode` 这个
  // 看不到账号凭据（`<sandbox>/.zcode/v2/credentials.json`）的空数据根。
  const dataBaseDir = explicit && path ? path.dirname(explicit) : '';
  const baseDir = dataBaseDir || sandboxDir;
  const set = {};
  if (baseDir) set.ZCODE_DATA_BASE_DIR = baseDir;
  return { set, unset: [] };
}

const zcodeStrategy = Object.freeze({
  name: 'zcode-data-base-dir',
  prepare,
  buildEnvPatch
});

module.exports = { zcodeStrategy };
