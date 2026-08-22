'use strict';

const {
  ZCODE_CREDENTIAL_SECRET_ENV,
  resolveZcodeCredentialSecret
} = require('../../account/zcode-credential');
const {
  ZCODE_DESKTOP_APPLICATION_NAME_ENV,
  buildZcodeDesktopApplicationName,
  parseZcodeDesktopApplicationName
} = require('../../runtime/account-app-process-marker');
const {
  AIH_ZCODE_SESSION_SCOPE_ENV
} = require('../../runtime/zcode-session-attribution-hook');
const { createDesktopLaunchStrategy } = require('./default-strategy');

const ZCODE_SESSION_ATTRIBUTION_RUNNER_PATH = require.resolve('../../runtime/zcode-session-attribution-runner');

// 多实例：ZCode 的单实例锁按 application name 判重而非 --user-data-dir
// （实测验证），因此按 accountRef 派生稳定的应用名，同账号恒定、跨账号互异。
// macOS 主进程会把命令行改写为 application name，因此单实例检测与 app-entries
// 运行态映射都必须同时支持 user-data-dir 与应用名两种身份。
function resolveInstanceName(ctx) {
  return buildZcodeDesktopApplicationName(ctx && ctx.accountRef);
}

function decorateLaunchEnv(env, ctx) {
  // ZCode Desktop 与 CLI 对 ZCODE_DATA_BASE_DIR 的语义不同：CLI 把它当作
  // .zcode 根目录本身，Desktop 宿主则在其下再拼一层 .zcode（getZCodeDataRootDir）。
  // 沿用 CLI env 会让 Desktop 去找 <sandbox>/.zcode/.zcode/v2/credentials.json，
  // 凭据找不到而落到 Welcome 登录页；桌面启动必须回指到沙箱父目录，
  // 并用 ZCODE_HOME 照顾 CUA helper 等按 ZCODE_HOME 取根的子系统。
  env.ZCODE_DATA_BASE_DIR = ctx.profileDir;
  env.ZCODE_HOME = ctx.path.join(ctx.profileDir, '.zcode');
  // ZCode 的凭据密钥默认包含 os.homedir()。macOS 下把 HOME 切到账号沙箱后，
  // os.homedir() 也随之改变，宿主 HOME 下加密的 OAuth 凭据会全部解密失败，
  // ZCode 随后把 credentials.json 回写成空对象。先在宿主环境派生稳定密钥，
  // 再显式传给子进程，既保留 setting.json 的 HOME 隔离，也不改变密文身份。
  const resolveSecret = (ctx.deps && typeof ctx.deps.resolveZcodeCredentialSecret === 'function')
    ? ctx.deps.resolveZcodeCredentialSecret
    : resolveZcodeCredentialSecret;
  env[ZCODE_CREDENTIAL_SECRET_ENV] = resolveSecret(ctx.getBaseEnv());
  // ZCode 的 settingService（main 与 host 相同实现 resolveUserHomeDir）写死按
  // HOME || USERPROFILE 取 <home>/.zcode/v2/setting.json，无视 ZCODE_DATA_BASE_DIR /
  // ZCODE_HOME。setting.json 持有 modelProviderFamilySelectedKeys /
  // providerFamilyDomain 等套餐选择状态；沙箱链路默认把 HOME/USERPROFILE 指回真实
  // 家目录，导致所有账号实例共享同一份 setting.json 互踩——A 实例写入的套餐域
  // （如 bigmodel）会让只有 z.ai 凭证的 B 实例启动后显示"套餐未连接/无可用模型"
  // （假登陆）。因此 zcode 桌面启动把 HOME 指向账号沙箱，让 setting.json 的读写
  // 都落在投影内（resolveUserHomeDir 里 HOME 优先于 USERPROFILE）。
  // 注意：USERPROFILE 不能一起改——实测（Windows，ZCode 1.x）只要 USERPROFILE
  // 指向投影目录，主进程就在 deep-link 注册前静默卡死（窗口/宿主进程都不起），
  // 只改 HOME 则完全正常。Electron userData 由 --user-data-dir 显式指定，
  // 不受 HOME 影响；凭据/缓存/日志本就走 ZCODE_HOME，语义不变。
  env.HOME = ctx.profileDir;
  // 不设 ZCODE_DESKTOP_SESSION_DATA_DIR——它会搬移 session 存储导致登出。
  // 注意：多个实例都注册 zcode:// deep-link，多账号同时开着时 OAuth 回调
  // 可能落到错误的实例，建议只开当前要登录的那一个账号的 Desktop。
  env[ZCODE_DESKTOP_APPLICATION_NAME_ENV] = ctx.applicationName;
}

function decorateResolvedLaunchEnv(env, resolved, ctx) {
  if (ctx.platformKey !== 'macos') return;
  const bundlePath = String(resolved && resolved.bundlePath || '').trim();
  if (!bundlePath) return;
  const agentEntry = ctx.path.join(bundlePath, 'Contents', 'Resources', 'glm', 'zcode.cjs');
  const nodeExecutable = String(ctx.deps && ctx.deps.nodeExecutablePath || process.execPath).trim();
  if (!nodeExecutable) return;

  // ZCode 会把共享本地 session ID 同时放进 X-Session-Id 与 Anthropic metadata。
  // AIH 又允许 OAuth 账号共享历史会话；若直接透传，同一服务端 admission 身份会
  // 跨账号累计。显式 runner 只装饰 agent 子进程并加载原始 zcode.cjs，不改
  // SQLite/history，也不修改已签名的网络请求或客户端安装包。
  env[AIH_ZCODE_SESSION_SCOPE_ENV] = ctx.accountRef;
  env.ZCODE_AGENT_SERVER_COMMAND = nodeExecutable;
  env.ZCODE_AGENT_SERVER_ARGS_JSON = JSON.stringify([
    ZCODE_SESSION_ATTRIBUTION_RUNNER_PATH,
    agentEntry,
    'app-server',
    '--stdio'
  ]);
}

const zcodeDesktopLaunchStrategy = createDesktopLaunchStrategy({
  name: 'zcode',
  resolveInstanceName,
  parseInstanceName: parseZcodeDesktopApplicationName,
  decorateLaunchEnv,
  decorateResolvedLaunchEnv
});

module.exports = { zcodeDesktopLaunchStrategy };
