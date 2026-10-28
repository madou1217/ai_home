'use strict';

const { ensureZcodeSharedSessionState } = require('./zcode-shared-session-store');
const {
  ZCODE_CREDENTIAL_SECRET_ENV,
  resolveZcodeCredentialSecret
} = require('../../../../account/zcode-credential');

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
  const baseEnv = (ctx && ctx.baseEnv && typeof ctx.baseEnv === 'object') ? ctx.baseEnv : {};
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
  // 凭据库（`<dataBaseDir>/.zcode/v2/credentials.json`）用**派生自 HOME 的密钥**加密
  // （CLI bundle：`ZCODE_CREDENTIAL_SECRET`，缺省 `zcode-credential-fallback:<platform>:<homedir>:<user>`）。
  // 沙箱把 HOME 指到账号目录，派生值随之改变 → 不解密就看不到账号态：注册表视图为空，
  // `-p` 报 "Select a model before sending a message"、TUI 里没有可选模型。
  // 因此在**宿主环境**派生一次并显式传给子进程（与桌面策略同源，实现在
  // lib/account/zcode-credential.js，不在两处各写一份派生规则）。
  set[ZCODE_CREDENTIAL_SECRET_ENV] = resolveZcodeCredentialSecret(baseEnv);
  // HOME 指向账号沙箱（与桌面策略同源）：CLI 有一批 **HOME 派生**的状态路径不认
  // ZCODE_DATA_BASE_DIR —— 凭据库、`<home>/.zcode/v2/setting.json`、账号态（provider
  // registry 的 `entitled` overlay 由「该 family 的 OAuth access_token 是否存在」推出）。
  // HOME 留在宿主会让多账号互踩同一份状态（真机表现：`-p` 报 "Select a model before
  // sending a message"、TUI 里没有可选模型）。
  // 注意：**USERPROFILE 不能一起改**（Windows 上只要 USERPROFILE 指向投影，ZCode 主进程
  // 就在 deep-link 注册前静默卡死——见 lib/server/desktop-launch/zcode-strategy.js）。
  // HOME 改变后凭据派生密钥随之改变，所以上一行的显式密钥是必须的（两者配套）。
  if (sandboxDir) set.HOME = sandboxDir;
  return { set, unset: [] };
}

const zcodeStrategy = Object.freeze({
  name: 'zcode-data-base-dir',
  prepare,
  buildEnvPatch
});

module.exports = { zcodeStrategy };
