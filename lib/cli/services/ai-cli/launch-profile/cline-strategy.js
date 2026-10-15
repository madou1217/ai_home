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
 * 只有 cline 自己的配置与本地状态不同。
 *
 * **会话历史例外（2026-10-15）**：会话不属于账号——宿主 `cline /history` 与
 * `aih cline` 必须看到同一批会话。因此 `data/sessions`、`data/db/sessions.db`、
 * `data/db/session-search.db`、`data/checkpoint-scratch` 由
 * `cline-shared-session-store` 链回宿主 `~/.cline`；凭据（`data/settings/providers.json`、
 * `data/secrets.json`）与缓存/日志仍留在投影里。见
 * launch-profile/cline-shared-session-store.js。
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

const {
  CLINE_PASS_PROVIDER_ID,
  selectClineOAuthCredential
} = require('../../../../account/cline-credentials');
const { ensureClineSharedSessionState } = require('./cline-shared-session-store');

/**
 * @param {SandboxLaunchContext & {fs?: any}} ctx
 */
function prepare(ctx) {
  const { fs, sandboxDir, path } = ctx || {};
  if (!fs || !sandboxDir || !path || typeof fs.mkdirSync !== 'function') return;
  // 首次登录（登录投影）与普通启动都要先有配置根，否则 CLI 会把 CA bundle 写到宿主。
  fs.mkdirSync(path.join(sandboxDir, '.cline'), { recursive: true, mode: 0o700 });
  // 会话历史链回宿主同一份（best-effort，绝不抛出）：宿主 `cline /history` 与
  // `aih cline` 因此看到同一批会话；凭据/配置仍留在账号投影里。
  ensureClineSharedSessionState({
    fs,
    path,
    sandboxDir,
    hostHomeDir: ctx && ctx.hostHomeDir
  });
}

const PROVIDERS_DOCUMENT_RELATIVE_PATH = Object.freeze(['.cline', 'data', 'settings', 'providers.json']);

function hasExplicitProviderFlag(argv) {
  const list = Array.isArray(argv) ? argv : [];
  return list.some((arg) => {
    const value = String(arg || '').trim();
    return value === '-P' || value === '--provider' || value.startsWith('--provider=');
  });
}

/**
 * `-P/--provider` 推导（**这是 Cline Pass 账号能直接用起来的关键**）。
 *
 * Cline CLI 的 provider 默认值是 `cline`，走的是 **Cline Credits** 通道；Cline Pass 订阅的
 * 凭据落在 `cline-pass` 槽位。不显式指定槽位时，订阅账号会先要求设备码登录、然后报
 * `Insufficient balance. Your Cline Credits balance is $0.00`（2026-10-15 本机实测：
 * 不带 `-P` 必失败，`-P cline-pass` 正常返回）。
 *
 * 因此：投影文档里 `cline-pass` 槽位有可用 OAuth 凭据就补 `-P cline-pass`；
 * API Key / 普通 cline 账号保持默认（它们本来就走 `cline` 槽位）。
 * 用户自己传了 `-P/--provider` 时不覆盖。
 *
 * @param {SandboxLaunchContext & {fs?: any, argv?: string[]}} ctx
 * @returns {string[]} 追加到 argv 前面的参数
 */
function buildLaunchArgs(ctx = {}) {
  const { fs, sandboxDir, path, argv } = ctx;
  if (!fs || !sandboxDir || !path || typeof fs.readFileSync !== 'function') return [];
  if (hasExplicitProviderFlag(argv)) return [];
  const documentPath = path.join(sandboxDir, ...PROVIDERS_DOCUMENT_RELATIVE_PATH);
  let document = null;
  try {
    document = JSON.parse(fs.readFileSync(documentPath, 'utf8'));
  } catch (_error) {
    return [];
  }
  if (!document || typeof document !== 'object' || !document.providers) return [];
  const passCredential = selectClineOAuthCredential({
    providers: { [CLINE_PASS_PROVIDER_ID]: document.providers[CLINE_PASS_PROVIDER_ID] }
  });
  return passCredential ? ['-P', CLINE_PASS_PROVIDER_ID] : [];
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
  buildEnvPatch,
  // 启动参数整形（槽位推导）：见 buildLaunchArgs 的注释。
  buildLaunchArgs
});

module.exports = { clineStrategy, prepare, buildEnvPatch, buildLaunchArgs };
