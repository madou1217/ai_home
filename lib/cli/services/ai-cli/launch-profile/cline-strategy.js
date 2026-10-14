'use strict';

/**
 * Cline CLI（`cline`，bun 单文件分发）的启动隔离。
 *
 * CLI 的配置根与本地状态根各有一个 env 开关（与 `--config` / `--data-dir` 同义）：
 *
 *   CLINE_DIR      配置根（默认 ~/.cline：CA bundle、hooks、worktrees 都在它下面）
 *   CLINE_DATA_DIR 本地状态根（默认 <CLINE_DIR>/data：settings/providers.json、
 *                  secrets.json、sessions、db、logs 都在它下面）
 *
 * 两者都钉进账号沙箱，于是 HOME 保持宿主真实值（与 kiro / codebuddy 同构）：账号之间
 * 只有 cline 自己的配置与本地状态不同，不共享宿主 `~/.cline` 的任何数据。这也是
 * 存储策略把 projectionRoots 留空的前提（见 runtime/provider-storage-policy.js）。
 *
 * 2026-10-14 在本机实测：CLINE_DIR 决定 `cli-node-extra-ca-certs.pem` 的落点，
 * CLINE_DATA_DIR 决定 `data/settings`、`data/cache`、`data/logs` 的落点。
 *
 * 交互形态由 CLI 自己的 argv 决定，不需要注入参数：裸 `cline` 打开 TUI（非 TTY 下报
 * "interactive mode requires a TTY"），位置参数即一次性 prompt，`-i/--tui` 显式进 TUI。
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

/**
 * @param {SandboxLaunchContext & {fs?: any}} ctx
 */
function prepare(ctx) {
  const { fs, sandboxDir, path } = ctx || {};
  if (!fs || !sandboxDir || !path || typeof fs.mkdirSync !== 'function') return;
  // 首次登录（登录投影）与普通启动都要先有配置根，否则 CLI 会把 CA bundle 写到宿主。
  fs.mkdirSync(path.join(sandboxDir, '.cline'), { recursive: true, mode: 0o700 });
}

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  const { sandboxDir, path } = ctx || {};
  const set = {};
  if (sandboxDir && path) {
    const configDir = path.join(sandboxDir, '.cline');
    set.CLINE_DIR = configDir;
    set.CLINE_DATA_DIR = path.join(configDir, 'data');
  }
  return { set, unset: [] };
}

const clineStrategy = Object.freeze({
  name: 'cline-config-dir',
  prepare,
  buildEnvPatch
});

module.exports = { clineStrategy, prepare, buildEnvPatch };
