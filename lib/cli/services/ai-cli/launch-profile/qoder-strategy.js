'use strict';

/**
 * Qoder CLI launch isolation (global + CN).
 *
 * Qoder exposes an explicit `--config-dir` override for the user-level config
 * root. Account isolation therefore:
 *   1. keeps the real host HOME (shared caches / PATH / desktop apps),
 *   2. materialises encrypted auth under the per-account runtime dir,
 *   3. injects `--config-dir <runtimeDir>` at spawn (see pty/runtime.js).
 *
 * Env auth: `QODER_PERSONAL_ACCESS_TOKEN` (PAT) is account-scoped and re-injected
 * from the credential store when present.
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

const { buildSharedCacheEnv } = require('./home-redirect-strategy');
const { isQoderProvider } = require('../../../../account/qoder-auth-metadata');

const QODER_UNSET_ENV = Object.freeze([
  // Never inherit a host PAT into another account sandbox.
  'QODER_PERSONAL_ACCESS_TOKEN'
]);

/**
 * @param {SandboxLaunchContext & {fs?: any}} ctx
 */
function prepare(ctx) {
  const { fs, sandboxDir } = ctx || {};
  if (!fs || typeof fs.mkdirSync !== 'function') return;
  const configDir = String(sandboxDir || '').trim();
  if (!configDir) return;
  fs.mkdirSync(configDir, { recursive: true });
  // Qoder writes `.auth/machine_id` + encrypted credentials under the config root.
  fs.mkdirSync(ctx.path.join(configDir, '.auth'), { recursive: true });
}

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  const { hostHomeDir, path, baseEnv, cliName, sandboxDir, isLogin } = ctx || {};
  const set = {};
  const unset = [...QODER_UNSET_ENV];

  // PAT accounts re-inject from account env after strip; drop host leakage first.
  const accountPat = String(baseEnv && baseEnv.QODER_PERSONAL_ACCESS_TOKEN || '').trim();
  if (accountPat) {
    set.QODER_PERSONAL_ACCESS_TOKEN = accountPat;
  }

  if (hostHomeDir) {
    Object.assign(set, {
      HOME: hostHomeDir,
      USERPROFILE: hostHomeDir,
      ...buildSharedCacheEnv(hostHomeDir, path)
    });
  }

  // 登录流程必须靠**环境**指定配置根：`qodercli login` 不接受 `--config-dir`
  // （实测 `unknown option '--config-dir'`，见 web-account-auth-account-config 的说明）。
  // 不设的话 CLI 会写进宿主 `~/.qoder/.auth/user`，登录任务随后在沙箱里找不到产物，
  // 报「授权进程已结束，但未检测到新的授权结果」（2026-10-28 实测）。运行态仍走
  // 启动时注入的 `--config-dir <runtimeDir>`，两条路指向同一个配置根。
  const configRoot = String(sandboxDir || '').trim();
  if (isLogin && configRoot) {
    set.QODER_CONFIG_DIR = configRoot;
  }

  // CN vs global is entirely determined by the binary; keep env free of region
  // hints that would couple strategies. Mark for diagnostics only.
  if (isQoderProvider(cliName)) {
  }

  return { set, unset };
}

const qoderStrategy = Object.freeze({
  name: 'qoder-config-dir',
  prepare,
  buildEnvPatch
});

module.exports = {
  qoderStrategy,
  prepare,
  buildEnvPatch,
  QODER_UNSET_ENV
};
