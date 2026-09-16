'use strict';

/**
 * CodeBuddy Code CLI 的启动隔离（@tencent-ai/codebuddy-code）。
 *
 * CODEBUDDY_CONFIG_DIR 只隔离配置、会话和插件。内嵌 CLI 的登录态仍读取
 * os.homedir()/Library/Application Support/CodeBuddyExtension/Data/Public/auth，
 * 不受 configDir 控制。必须同时复用 HOME 隔离策略；可重建缓存继续共用宿主目录。
 * 共享 .info 由原生凭据边界按签发方/身份/时间校验后捕获与投影。
 *
 * 环境变量口径：
 *   - `CODEBUDDY_CONFIG_DIR`：总是注入，与 HOME 隔离共同生效。
 *   - `CODEBUDDY_API_KEY` / `CODEBUDDY_BASE_URL` / `CODEBUDDY_AUTH_TOKEN`：账号级
 *     凭据。调用方（provider-runtime-env）已把宿主的同名值整键剥掉，这里只把
 *     账号值重新注入；没注入的一律 unset，避免残留宿主身份。
 *   - `CODEBUDDY_INTERNET_ENVIRONMENT`（internal / ioa）：不属于凭据，而是账号的
 *     区域选择。它随 `ACCOUNT_SCOPED_ENV_KEYS` 一起被剥离宿主值。国际站账号没配
 *     就自然不存在——本策略不替它猜站点；国内站 Provider（codebuddycn）则必须
 *     有确定站点，否则同一账号会随机打到国际站，因此用 Provider 级默认值
 *     `internal` 兜底（见 DEFAULT_INTERNET_ENVIRONMENT_BY_PROVIDER）。
 *   - `CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT`：IDE / Copilot 侧读取的同义开关，
 *     与上一个键一起写，避免 CLI 与 IDE 落到不同站点。
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

const { homeRedirectStrategy } = require('./home-redirect-strategy');

// 账号沙箱内 CLI 真正的 configDir 名。CLI 二进制国内站/国际站是同一个
// （@tencent-ai/codebuddy-code），但两个站点是两个 Provider，投影根必须分开，
// 否则同一台机器上两个 Provider 的账号会看到同一个目录名。名字与各自的
// `CLIConfig.globalDir` 严格一致（国际站 .codebuddy / 国内站 .codebuddy-cn），
// 由 `provider-storage-policy` 的 projectionRoots 使用同一口径。
const CODEBUDDY_CONFIG_DIR_NAME = '.codebuddy';
const CODEBUDDY_CN_CONFIG_DIR_NAME = '.codebuddy-cn';

const CONFIG_DIR_NAME_BY_PROVIDER = Object.freeze({
  codebuddy: CODEBUDDY_CONFIG_DIR_NAME,
  codebuddycn: CODEBUDDY_CN_CONFIG_DIR_NAME,
  workbuddy: '.workbuddy-ai',
  workbuddycn: '.workbuddy'
});

// 站点默认值。国内站 Provider（codebuddycn）的账号若不显式覆盖，必须固定成
// `internal`：CLI 与 IDE 各读一个键，只设一个会出现"CLI 打国内站、IDE 打国际站"
// 的静默分裂，所以两个键一起写。国际站（codebuddy）不设默认值——CLI 首启会让
// 用户选站点，AIH 不替账号决定。
const DEFAULT_INTERNET_ENVIRONMENT_BY_PROVIDER = Object.freeze({
  codebuddycn: 'internal',
  workbuddycn: 'internal'
});

// 永不从宿主继承的账号级变量。宿主的 CODEBUDDY_API_KEY 属于另一个账号，
// 泄漏到本账号 sandbox 会让 OAuth 账号静默改用别人的密钥。
//
// 注意：调用方先 Apply set、再 Apply unset，所以这里绝不能无条件下发
// `unset`，否则会把同一轮 set 进去的账号密钥删掉（与 kimi-strategy 同款约束）。
const CODEBUDDY_NEVER_INHERIT_ENV = Object.freeze([
  'CODEBUDDY_API_KEY',
  'CODEBUDDY_BASE_URL',
  'CODEBUDDY_AUTH_TOKEN'
]);

/**
 * 解析账号 sandbox 内的 configDir。
 *
 * @param {SandboxLaunchContext} ctx
 * @returns {string} 绝对路径；入参不完整时返回 ''
 */
function resolveCodebuddyConfigDir(ctx) {
  const { sandboxDir, path, cliName } = ctx || {};
  const root = String(sandboxDir || '').trim();
  if (!root || !path || typeof path.join !== 'function') return '';
  const dirName = CONFIG_DIR_NAME_BY_PROVIDER[String(cliName || '').trim()]
    || CODEBUDDY_CONFIG_DIR_NAME;
  return path.join(root, dirName);
}

/**
 * 预建 configDir。CLI 自己会 bootstrap settings.json / plugins / logs 等，
 * 但父目录不存在时首个进程会先失败再重试，预建可以省掉这次失败。
 *
 * @param {SandboxLaunchContext & {fs?: any}} ctx
 */
function prepare(ctx) {
  const { fs } = ctx || {};
  if (!fs || typeof fs.mkdirSync !== 'function') return;
  const configDir = resolveCodebuddyConfigDir(ctx);
  if (!configDir) return;
  fs.mkdirSync(configDir, { recursive: true });
}

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  const { baseEnv, cliName } = ctx || {};
  const configDir = resolveCodebuddyConfigDir(ctx);
  const { set } = homeRedirectStrategy.buildEnvPatch(ctx);

  if (configDir) set.CODEBUDDY_CONFIG_DIR = configDir;
  if (configDir && String(cliName).startsWith('workbuddy')) set.WORKBUDDY_CONFIG_DIR = configDir;

  // API Key 账号：从账号 env 重新注入（调用方已先剥离宿主值）。
  const apiKey = String(baseEnv && baseEnv.CODEBUDDY_API_KEY || '').trim();
  const baseUrl = String(baseEnv && baseEnv.CODEBUDDY_BASE_URL || '').trim();
  const authToken = String(baseEnv && baseEnv.CODEBUDDY_AUTH_TOKEN || '').trim();
  if (apiKey) set.CODEBUDDY_API_KEY = apiKey;
  if (baseUrl) set.CODEBUDDY_BASE_URL = baseUrl;
  if (authToken) set.CODEBUDDY_AUTH_TOKEN = authToken;

  // 站点：账号显式配置优先，否则用 Provider 的站点默认值（仅国内站有默认值）。
  const accountRegion = String(baseEnv && baseEnv.CODEBUDDY_INTERNET_ENVIRONMENT || '').trim();
  const region = accountRegion
    || DEFAULT_INTERNET_ENVIRONMENT_BY_PROVIDER[String(cliName || '').trim()]
    || '';
  if (region) {
    set.CODEBUDDY_INTERNET_ENVIRONMENT = region;
    set.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT = region;
  }

  // 只 unset 本轮没有重新注入的键：官方非交互模式固定读 CODEBUDDY_API_KEY，
  // 残留宿主值会静默改写账号身份。
  const unset = CODEBUDDY_NEVER_INHERIT_ENV
    .filter((key) => !Object.prototype.hasOwnProperty.call(set, key));

  return { set, unset };
}

const codebuddyStrategy = Object.freeze({
  name: 'codebuddy-config-dir',
  prepare,
  buildEnvPatch
});

module.exports = {
  codebuddyStrategy,
  prepare,
  buildEnvPatch,
  resolveCodebuddyConfigDir,
  CODEBUDDY_CONFIG_DIR_NAME,
  CODEBUDDY_CN_CONFIG_DIR_NAME,
  CONFIG_DIR_NAME_BY_PROVIDER,
  CODEBUDDY_NEVER_INHERIT_ENV
};
