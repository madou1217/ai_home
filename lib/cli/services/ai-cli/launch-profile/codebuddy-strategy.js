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
 *   - `CODEBUDDY_CONFIG_DIR`：CLI 两支（codebuddy / codebuddycn）指向家族规范配置根
 *     `~/.codebuddy`，不再指向账号投影。CLI 2.181.0 起，agent view 的会话列表要求
 *     `<configDir>/projects` 及其每个 project 子目录都是**真实目录**：软链接会直接抛
 *     `Session projects catalog is not a regular directory`（/resume /stats 都走这条
 *     路径）。家族会话只有一份、规范存储就是 `~/.codebuddy/projects`，所以配置根必须
 *     落在这里。账号投影 configDir 仍由 prepare 维护（配置视图 / 旧进程兼容），
 *     但不再是 CLI 进程的 configDir。WorkBuddy 桌面两支的配置根是另一套 schema，
 *     继续用账号投影。
 *   - `CODEBUDDY_API_KEY` / `CODEBUDDY_BASE_URL` / `CODEBUDDY_AUTH_TOKEN`：账号级
 *     凭据。调用方（provider-runtime-env）已把宿主的同名值整键剥掉，这里只把
 *     账号值重新注入；没注入的一律 unset，避免残留宿主身份。
 *   - `CODEBUDDY_INTERNET_ENVIRONMENT`（internal / external / ioa）：不属于凭据，
 *     而是账号的区域选择。它随 `ACCOUNT_SCOPED_ENV_KEYS` 一起被剥离宿主值。
 *     **每一支都必须有确定站点**：CLI 缺省按 `internal` 解析，国际站账号会因此把
 *     .ai 的 token 发到 copilot.tencent.com（业务与 refresh 双 401）。站点由
 *     Provider 级默认值固定（见 DEFAULT_INTERNET_ENVIRONMENT_BY_PROVIDER），
 *     账号显式配置优先。
 *   - `CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT`：IDE / Copilot 侧读取的同义开关，
 *     与上一个键一起写，避免 CLI 与 IDE 落到不同站点。
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

const { homeRedirectStrategy } = require('./home-redirect-strategy');
const { seedInheritedFolderTrust } = require('../../../../runtime/codebuddy-folder-trust');
const { linkSharedConfigForProjection } = require('../../../../runtime/codebuddy-shared-config');
const { ensureCodebuddyImagePasteHook } = require('../../../../runtime/codebuddy-image-paste-hook');

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

// 站点默认值：**每一支都必须显式固定**，不能留空。
//
// 2026-11-10 真机：CLI 在没有 `CODEBUDDY_INTERNET_ENVIRONMENT` 时默认按
// `internal`（copilot.tencent.com）解析。AIH 会把宿主同名变量当账号级残留剥掉，
// 于是国际站账号（token 由 www.codebuddy.ai 签发）也被发到国内站端点：业务请求
// 401，CLI 自己的 refreshSession 同样 401，最终只能提示 `/login`。
//
// 两个键一起写：CLI 与 IDE 各读一个，只设一个会出现"CLI 打 A 站、IDE 打 B 站"
// 的静默分裂。
const DEFAULT_INTERNET_ENVIRONMENT_BY_PROVIDER = Object.freeze({
  codebuddy: 'external',
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

// CLI 两支的配置根：家族规范存储 ~/.codebuddy。
//
// CLI 2.181.0 的 agent view 用 lstat 校验会话目录（/resume、/stats 都走
// getAllByWorkdir → listCatalogProjectDirectories）：<configDir>/projects 与每个
// project 子目录都必须是真实目录，软链接会抛
//   Session projects catalog is not a regular directory: <path>
// 账号投影里的 projects 是共享会话存储的软链接，因此 CLI 进程不能再把 configDir
// 指向投影。规范存储本身就是 ~/.codebuddy/projects（真实目录），家族会话也只有
// 这一份，直接用它即可。WorkBuddy 桌面两支不在此列：它们的配置根是桌面 App
// 自己的 schema，仍留在账号投影。
const CODEBUDDY_SHARED_CONFIG_ROOT_PROVIDERS = Object.freeze(['codebuddy', 'codebuddycn']);

function resolveCodebuddyLaunchConfigDir(ctx) {
  const { path, hostHomeDir, cliName } = ctx || {};
  const name = String(cliName || '').trim();
  const hostHome = String(hostHomeDir || '').trim();
  if (
    CODEBUDDY_SHARED_CONFIG_ROOT_PROVIDERS.includes(name)
    && hostHome
    && path
    && typeof path.join === 'function'
  ) {
    return path.join(hostHome, CODEBUDDY_CONFIG_DIR_NAME);
  }
  return resolveCodebuddyConfigDir(ctx);
}

/**
 * 预建 configDir。CLI 自己会 bootstrap settings.json / plugins / logs 等，
 * 但父目录不存在时首个进程会先失败再重试，预建可以省掉这次失败。
 *
 * **悬空符号链接必须先清掉**：沙箱投影会把 `.workbuddy-ai` 之类链回宿主同名目录，
 * 而宿主那份在用户没装/没跑过对应 App 时并不存在。`mkdirSync(recursive)` 遇到
 * 「符号链接指向不存在的目标」会抛 ENOENT（而不是像普通缺失路径那样直接建目录），
 * 于是整个 provider env 构建失败、会话起不来 —— 实测 2026-10-26：装 WorkBuddy AI.app
 * 之前，`buildProviderEnv('workbuddy', …)` 恒定 ENOENT，装上后宿主目录被建出才自愈。
 * 这里主动探测并重建，让「宿主目标还没出现」不再阻断会话。
 *
 * @param {SandboxLaunchContext & {fs?: any}} ctx
 */
function prepare(ctx) {
  const { fs } = ctx || {};
  if (!fs || typeof fs.mkdirSync !== 'function') return;
  const configDir = resolveCodebuddyConfigDir(ctx);
  if (!configDir) return;
  const launchConfigDir = resolveCodebuddyLaunchConfigDir(ctx) || configDir;
  // CLI 进程实际读取的配置根（CLI 两支是规范存储）。后续 hook / 目录信任都要写到这里，
  // 否则新机器上规范根还不存在时，写进投影的设置 CLI 根本读不到。
  if (launchConfigDir && launchConfigDir !== configDir) {
    try { fs.mkdirSync(launchConfigDir, { recursive: true }); } catch (_error) { /* 启动时 CLI 自己也会建 */ }
  }
  let ready = false;
  try {
    fs.mkdirSync(configDir, { recursive: true });
    ready = true;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (!ready) {
    // 走到这里说明 mkdir 因「中间层是悬空符号链接」失败：清掉那层链接再建真目录。
    if (typeof fs.lstatSync !== 'function' || typeof fs.unlinkSync !== 'function') return;
    let existing = null;
    try { existing = fs.lstatSync(configDir); } catch (_error) { existing = null; }
    if (!existing || !existing.isSymbolicLink()) return;
    try {
      fs.unlinkSync(configDir);
      fs.mkdirSync(configDir, { recursive: true });
      ready = true;
    } catch (_error) {
      // 清不掉（权限/竞态）时保持原行为：由调用方决定是否继续。
    }
  }
  if (!ready) return;

  // 登录 / 首次启动都先把配置接上：新账号从 login 那一刻起就用家族共享的
  // settings.json / statusLine / argv.json，不用登录完再配一遍（用户 2026-11-01 口径）。
  // 只对 CLI 配置根生效（.codebuddy / .codebuddy-cn），WorkBuddy 桌面根不动。
  try {
    linkSharedConfigForProjection({
      fs,
      path: ctx.path,
      configDir,
      hostHomeDir: ctx.hostHomeDir
    });
  } catch (_error) {
    // 建链失败最多让这个账号先用自己那份配置，不影响登录。
  }

  // 粘贴图片自动借视觉：iTerm2 只把临时图片路径贴进输入框，CodeBuddy 的
  // UserPromptSubmit hook 在这里把它换成 aih 网关视觉模型的描述。
  // WorkBuddy 桌面 settings 是另一套 schema，不装。
  if (!String(ctx.cliName || '').startsWith('workbuddy')) {
    try {
      ensureCodebuddyImagePasteHook({
        fs,
        path: ctx.path,
        configDir: launchConfigDir
      });
    } catch (_error) {
      // hook 安装失败最多退回手动 /aih-collab，不影响启动。
    }
  }

  if (ctx.isLogin) return;

  // 目录信任记忆（见 runtime/codebuddy-folder-trust.js）：CLI 把「Do you trust the files
  // in this folder?」的回答只写进当前账号投影的 settings.json，于是同一目录换个账号
  // 就再问一遍。启动前把家族里已经做过的决定补给本次 configDir —— 只补已有的决定，
  // 新目录仍然由用户自己回答一次。
  try {
    seedInheritedFolderTrust({
      fs,
      path: ctx.path,
      configDir: launchConfigDir,
      directory: String(ctx.cwd || process.cwd()),
      hostHomeDir: ctx.hostHomeDir,
      aiHomeDir: ctx.aiHomeDir
    });
  } catch (_error) {
    // 记忆失败最多让用户再答一次，不影响启动。
  }
}

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  const { baseEnv, cliName } = ctx || {};
  const configDir = resolveCodebuddyConfigDir(ctx);
  const launchConfigDir = resolveCodebuddyLaunchConfigDir(ctx);
  const { set } = homeRedirectStrategy.buildEnvPatch(ctx);

  // CLI 两支用规范存储（projects 必须是真实目录）；WorkBuddy 桌面两支继续用投影。
  if (launchConfigDir) set.CODEBUDDY_CONFIG_DIR = launchConfigDir;
  if (configDir && String(cliName).startsWith('workbuddy')) set.WORKBUDDY_CONFIG_DIR = configDir;

  // API Key 账号：从账号 env 重新注入（调用方已先剥离宿主值）。
  const apiKey = String(baseEnv && baseEnv.CODEBUDDY_API_KEY || '').trim();
  const baseUrl = String(baseEnv && baseEnv.CODEBUDDY_BASE_URL || '').trim();
  const authToken = String(baseEnv && baseEnv.CODEBUDDY_AUTH_TOKEN || '').trim();
  if (apiKey) set.CODEBUDDY_API_KEY = apiKey;
  if (baseUrl) set.CODEBUDDY_BASE_URL = baseUrl;
  if (authToken) set.CODEBUDDY_AUTH_TOKEN = authToken;

  // 站点：账号显式配置优先，否则用 Provider 的站点默认值（两支都固定，不留空）。
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
  resolveCodebuddyLaunchConfigDir,
  CODEBUDDY_CONFIG_DIR_NAME,
  CODEBUDDY_CN_CONFIG_DIR_NAME,
  CONFIG_DIR_NAME_BY_PROVIDER,
  CODEBUDDY_NEVER_INHERIT_ENV
};
