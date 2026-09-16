'use strict';

/**
 * CodeBuddy Provider 集成契约测试。
 *
 * 覆盖本轮集成的四条边界（静态定义 / 账号身份 / 存储与启动隔离 / 安装启动），
 * 每条边界都对齐本仓库既有的 per-provider 约定。这里只断言"声明的事实"，不
 * 复述实现细节，避免测试变成实现的第二份副本。
 *
 * 范围边界：会话历史**已接入**（session_history + polling；适配器在
 * lib/sessions/session-reader-codebuddy.js，其行为断言在
 * test/session-reader-codebuddy.test.js），codebuddy/codebuddycn 同时具备原生续聊能力。
 * 仍未接入的是网关路由与用量探测，因此这里没有相关断言——一旦将来接入，应先补实现
 * 再补这里的断言。
 */

const test = require('node:test');
const { credential: familyCredential } = require('./helpers/codebuddy-credential');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// CodeBuddy 家族的四个 Provider：两个站点 × 两条产品线。
// 国内/国际各是一套不互通的账号，所以永远是四个 Provider，不是两个。
const FAMILY_PROVIDERS = Object.freeze(['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']);

// --- 1. Provider 目录（生成的合同投影） ---
const {
  isKnownProvider,
  PROVIDER_IDS,
  getProviderMeta,
  getProviderCLIConfig,
  getProviderClientSupport,
  getProviderAuthOptions,
  providerSupports
} = require('../lib/provider-catalog');

test('provider catalog includes codebuddy and resolves case-insensitively', () => {
  assert.ok(PROVIDER_IDS.includes('codebuddy'), 'codebuddy should be in PROVIDER_IDS');
  assert.equal(isKnownProvider('codebuddy'), true);
  assert.equal(isKnownProvider('CODEBUDDY'), true, 'case-insensitive');
  assert.equal(isKnownProvider('CodeBuddy'), true, 'case-insensitive mixed case');
});

test('codebuddy presentation matches the declared brand surface', () => {
  const meta = getProviderMeta('codebuddy');
  assert.equal(meta.id, 'codebuddy');
  assert.equal(meta.label, 'CodeBuddy');
  assert.equal(meta.short, 'CB');
  // 终端文本图标与 web/src/assets/icons/codebuddy.svg 的菱形记号同形。
  assert.equal(meta.terminalIcon, '❖');
  // 该路径必须与 scripts/gen-codebuddy-icon.js 的输出路径一致。
  assert.equal(meta.terminalIconAsset, 'assets/provider-icons/codebuddy.png');
  assert.equal(meta.accentVar, 'var(--provider-codebuddy)');
  assert.equal(meta.softVar, 'var(--provider-codebuddy-soft)');
});

test('codebuddy declares both CLI and Desktop clients', () => {
  assert.deepEqual(getProviderClientSupport('codebuddy'), { cli: true, desktop: true });
});

test('codebuddy auth options cover browser login and API key', () => {
  const values = getProviderAuthOptions('codebuddy').map((option) => option.value);
  assert.deepEqual(values, ['oauth-browser', 'api-key']);
});

// 能力面是刻意收敛的：只有已实现适配器的能力才允许声明。声明未实现的能力会让
// WebUI/gateway 认为该 provider 支持对应功能，进而产生空轮询或 404。
test('codebuddy declares api_key_account, session_history and quota_usage', () => {
  assert.equal(providerSupports('codebuddy', 'api_key_account'), true);
  // 会话读取适配器已落地，因此允许声明 session_history。
  assert.equal(providerSupports('codebuddy', 'session_history'), true);
  // 余额/积分接口已接入（POST {endpoint}/billing/meter/get-user-resource-summary，
  // 适配器 lib/cli/services/usage/codebuddy-quota-probe.js），因此允许声明 quota_usage。
  assert.equal(providerSupports('codebuddy', 'quota_usage'), true);
  // account_session_store 刻意保持不声明：会话读的是宿主地区目录而不是账号沙箱，
  // 声明它会把列表判成"按账号隔离"，而"切换账号不变历史"正是本轮要保证的行为。
  assert.equal(providerSupports('codebuddy', 'account_session_store'), false);
  for (const capability of [
    'model_catalog',
    'session_runtime',
    'fabric_runtime',
    'gateway_profile',
    'usage_scan'
  ]) {
    assert.equal(
      providerSupports('codebuddy', capability),
      false,
      `${capability} must stay undeclared until an adapter exists`
    );
  }
});

// --- 2. CLI 运行配置（隔离与调用形态依赖这些字段） ---
test('codebuddy CLI config pins the configDir, binary and package', () => {
  const config = getProviderCLIConfig('codebuddy');
  assert.ok(config, 'codebuddy CLI config should exist');
  assert.equal(config.globalDir, '.codebuddy');
  assert.equal(config.configFile, 'settings.json');
  assert.equal(config.binaryName, 'codebuddy');
  assert.equal(config.pkg, '@tencent-ai/codebuddy-code');
  // CLI 没有 login 子命令：登录由裸启动的交互式选择完成，因此 loginArgs 为空。
  assert.deepEqual(config.loginArgs, []);
});

test('codebuddy CLI env contract includes the site selector and auth token', () => {
  const config = getProviderCLIConfig('codebuddy');
  for (const key of [
    'CODEBUDDY_API_KEY',
    'CODEBUDDY_BASE_URL',
    'CODEBUDDY_AUTH_TOKEN',
    'CODEBUDDY_INTERNET_ENVIRONMENT',
    // CLI 与 IDE 各读一个站点键，两个都要声明，否则只配一个会出现
    // "CLI 打国内站、IDE 打国际站"的静默分裂。
    'CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT',
    'CODEBUDDY_CONFIG_DIR'
  ]) {
    assert.ok(config.envKeys.includes(key), `${key} must be declared`);
  }
});

test('codebuddy treats -p/--print as the headless trigger', () => {
  const config = getProviderCLIConfig('codebuddy');
  assert.ok(config.headless, 'headless config should exist');
  assert.deepEqual(config.headless.triggerFlags, ['-p', '--print']);
});

// 不变量：`desktopClient[platform]` 存在 ⟺ 该平台有可执行的桌面安装计划。
// 违反它会展示一个无法安装/更新/卸载的应用（toolkit-app-lifecycle-matrix 的
// 三平台矩阵会因此失败）。CodeBuddy IDE 目前只有 macOS 有官方免交互安装源。
test('codebuddy declares a desktop client only on platforms with a real install plan', () => {
  const { desktopClient } = getProviderCLIConfig('codebuddy');
  assert.ok(desktopClient, 'desktopClient should exist');
  assert.equal(desktopClient.macos.clientName, 'CodeBuddy');
  // ExecNames 必须是 bundle 内真实存在的可执行名：CodeBuddy.app（VS Code 内核）
  // 的 Contents/MacOS 下只有 Electron。写成产品名会解析出不存在的可执行路径，
  // 桌面端重启链路会整体失效。
  assert.deepEqual(desktopClient.macos.execNames, ['Electron']);
  assert.equal(desktopClient.macos.bundleId, 'com.tencent.codebuddy');
  assert.ok(
    desktopClient.macos.installPaths.includes('/Applications/CodeBuddy.app'),
    'cask install location must be discoverable'
  );
  // 凭据不通用：桌面端不做 host auth 投影，首次登录由 App 自己完成（独立登录）。
  assert.equal(desktopClient.reloadsHostAuth, false);
  // Windows/Linux 官方只给浏览器下载页，没有可验证的免交互安装源，故不声明。
  assert.equal(desktopClient.windows, undefined);
  assert.equal(desktopClient.linux, undefined);

  const installer = getAppInstaller('codebuddy');
  const platforms = [['macos', 'darwin'], ['windows', 'win32'], ['linux', 'linux']];
  for (const [contractKey, installerPlatform] of platforms) {
    const declared = Boolean(desktopClient[contractKey]);
    const plans = installer.resolveDesktopInstallPlans({ platform: installerPlatform, hostHomeDir: '/h' });
    assert.equal(
      declared,
      plans.length > 0,
      `${contractKey}: declared=${declared} but plans=${plans.length} (must match)`
    );
  }
});

// --- 3. 账号身份 ---
const { resolveNativeAuthIdentitySeed, detectIdentityKind } = require('../lib/account/account-identity');

test('codebuddy identity seed resolves nested oauth payloads and stays stable', () => {
  const nativeAuth = { credentials: { oauth: { user_id: 'cb-user-42' } } };
  const seed = resolveNativeAuthIdentitySeed('codebuddy', nativeAuth).identitySeed;
  assert.ok(seed.startsWith('oauth:codebuddy:user:'), seed);
  assert.equal(
    seed,
    resolveNativeAuthIdentitySeed('codebuddy', nativeAuth).identitySeed,
    'seed must be stable across calls'
  );
});

test('codebuddy identity seed degrades to a token hash instead of failing', () => {
  const result = resolveNativeAuthIdentitySeed('codebuddy', { credentials: { access_token: 'tok-only' } });
  assert.equal(result.kind, 'oauth');
  assert.equal(result.degraded, false, 'token fallback is a normal, non-degraded resolution');
  assert.ok(result.identitySeed.startsWith('oauth:codebuddy:token:'), result.identitySeed);
});

test('codebuddy identity seed reports degraded when no credentials exist', () => {
  const result = resolveNativeAuthIdentitySeed('codebuddy', { credentials: {} });
  assert.equal(result.identitySeed, '');
  assert.equal(result.degraded, true);
});

test('CodeBuddy user id can coexist with email and a distinct organization account id', () => {
  const resolve = (credentials) => resolveNativeAuthIdentitySeed('codebuddycn', { credentials }).identitySeed;
  assert.equal(resolve({ oauth: { user_id: 'user-1', email: 'person@example.test', accountId: 'org-1' } }),
    resolve({ oauth: { user_id: 'user-1' } }));
  assert.equal(resolve({ account: { uid: 'user-1' }, auth: { accessToken: 'opaque-test-token' } }),
    resolve({ oauth: { user_id: 'user-1' } }));
  assert.equal(resolve({ account: { uid: 'user-1' }, auth: { user_id: 'user-2' } }), '');
});

test('codebuddy account with CODEBUDDY_API_KEY is detected as api-key type', (t) => {
  const { aiHomeDir, register } = createCodebuddyFixture(t);
  const accountRef = register('codebuddy', '1', { CODEBUDDY_API_KEY: 'codebuddy-test-key' });
  const kind = detectIdentityKind({ fs, aiHomeDir, provider: 'codebuddy', accountRef });
  assert.equal(kind, 'api-key');
});

// --- 4. 存储策略 ---
const {
  CODEBUDDY_CN_SHARED_AUTH_PATH,
  CODEBUDDY_EXTENSION_AUTH_DIR,
  getProviderStoragePolicy,
  getProviderAuthArtifacts,
  getProviderHostAuthRoot,
  getProviderPrivateArtifacts,
  getProviderPrivateEntryNames,
  getProviderSharedEntries
} = require('../lib/runtime/provider-storage-policy');
const {
  materializeProviderAuth,
  readProviderAuthProjection
} = require('../lib/account/native-auth-projection');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');
const { getOauthArtifactPath } = require('../lib/server/web-account-auth-oauth-tokens');

test('codebuddy storage policy roots at .codebuddy and isolates account-private state', () => {
  const policy = getProviderStoragePolicy('codebuddy');
  assert.ok(policy, 'codebuddy policy should exist');
  assert.deepEqual(policy.nativeRoot, ['.codebuddy']);
  // 共享凭据相对宿主 HOME，不属于本 Provider 的配置根。
  assert.deepEqual(policy.hostAuthRoot, []);

  // 会话按地区打通：projects 是宿主地区目录，投影进账号沙箱后仍指向同一份历史。
  assert.deepEqual(getProviderSharedEntries('codebuddy'), ['projects']);

  // 私有条目名只覆盖 nativeRoot 内部的第一层（与 codex 同口径）。
  const privateNames = getProviderPrivateEntryNames('codebuddy');
  for (const entry of ['settings.json', '.mcp.json', 'sessions']) {
    assert.ok(privateNames.includes(entry), `${entry} must stay account-private`);
  }

  // nativeRoot 之外的私有资产（Electron user-data、钥匙串）单独校验。
  const privatePaths = getProviderPrivateArtifacts('codebuddy').map((artifact) => artifact.path.join('/'));
  assert.ok(privatePaths.includes('electron-user-data'), 'desktop user data must stay account-private');
  assert.ok(privatePaths.includes('Library/Keychains'), 'keychains must stay account-private');
});

test('codebuddy captures the international CLI shared credential file', () => {
  const artifacts = getProviderAuthArtifacts('codebuddy');
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].field, 'credentials');
  // 实测（2.151.0）：国际站 CLI 与 CodeBuddy.app 的 authentication.id 都是
  // `Tencent-Cloud.coding-copilot`，所以不能再假设 ~/.codebuddy/.credentials.json
  //（两支 CLI 都不写那个文件）。
  assert.deepEqual(artifacts[0].path, [
    'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth',
    'Tencent-Cloud.coding-copilot.info'
  ]);
  assert.equal(artifacts[0].format, 'json');
});

test('no two sites in the family share a credential file', () => {
  // 2026-09-15 实测：auth 目录下**三份**文件并存，四个 Provider 各声明自己那支
  // 客户端真正读的一份。任何两份被声明成同一个文件，都会把两个站点的账号合并。
  const fileName = (segments) => segments[segments.length - 1];
  const declared = Object.fromEntries(
    FAMILY_PROVIDERS.map((provider) => [provider, fileName(getProviderAuthArtifacts(provider)[0].path)])
  );

  assert.deepEqual(declared, {
    codebuddy: 'Tencent-Cloud.coding-copilot.info',
    codebuddycn: 'workbuddy-desktop.info',
    workbuddy: 'workbuddy-desktop-ai.info',
    workbuddycn: 'workbuddy-desktop.info'
  });

  // 除文件名外同目录：都必须是 HOME 下 CodeBuddyExtension 的 auth 目录。
  for (const provider of FAMILY_PROVIDERS) {
    const segments = getProviderAuthArtifacts(provider)[0].path;
    assert.deepEqual(segments.slice(0, -1), CODEBUDDY_EXTENSION_AUTH_DIR, provider);
  }

  // 国际站两支各用各的文件；国内站两支共用同一个（CLI 与 App 同一账号）。
  assert.notEqual(declared.codebuddy, declared.workbuddy);
  assert.equal(declared.codebuddycn, declared.workbuddycn);

  // 国内站刻意**不声明**国际站那份站点不可归因的文件，避免把国际站 token
  // 静默导进国内站账号。
  for (const provider of ['codebuddycn', 'workbuddycn']) {
    const names = getProviderAuthArtifacts(provider).map((artifact) => fileName(artifact.path));
    assert.equal(names.includes(declared.codebuddy), false, provider);
  }
});

test('the two WorkBuddy sites resolve to different credential files and data roots', () => {
  // WorkBuddy 自己就是一条双站点产品线：国际站与本机并存的两份 .info 一一对应，
  // 数据根也各自独立（官方 cask zap 清单 + 实机目录：~/.workbuddy-ai 与 ~/.workbuddy）。
  const fileName = (provider) => getProviderAuthArtifacts(provider)[0].path.slice(-1)[0];
  assert.equal(fileName('workbuddy'), 'workbuddy-desktop-ai.info');
  assert.equal(fileName('workbuddycn'), 'workbuddy-desktop.info');

  assert.deepEqual(getProviderStoragePolicy('workbuddy').nativeRoot, ['.workbuddy-ai']);
  assert.deepEqual(getProviderStoragePolicy('workbuddycn').nativeRoot, ['.workbuddy']);
  assert.notDeepEqual(
    getProviderStoragePolicy('workbuddy').projectionRoots,
    getProviderStoragePolicy('workbuddycn').projectionRoots
  );
});

// --- 5. CLI 启动隔离（env 形态） ---
const { codebuddyStrategy, CODEBUDDY_CONFIG_DIR_NAME } = require('../lib/cli/services/ai-cli/launch-profile/codebuddy-strategy');
const { buildProviderRuntimeEnv } = require('../lib/cli/services/ai-cli/provider-runtime-env');

test('codebuddy launch strategy points CODEBUDDY_CONFIG_DIR at the sandbox .codebuddy', () => {
  const ctx = { sandboxDir: path.join(path.sep, 'sandbox', 'cb-1'), path, baseEnv: {}, isLogin: false };
  const patch = codebuddyStrategy.buildEnvPatch(ctx);
  assert.equal(
    patch.set.CODEBUDDY_CONFIG_DIR,
    path.join(ctx.sandboxDir, CODEBUDDY_CONFIG_DIR_NAME)
  );
  // 未注入的账号级凭据必须被 unset，防止继承宿主身份。
  assert.deepEqual(patch.unset, ['CODEBUDDY_API_KEY', 'CODEBUDDY_BASE_URL', 'CODEBUDDY_AUTH_TOKEN']);
});

test('codebuddy launch strategy re-injects account credentials without unsetting them', () => {
  const ctx = {
    sandboxDir: path.join(path.sep, 'sandbox', 'cb-2'),
    path,
    baseEnv: { CODEBUDDY_API_KEY: 'acct-key', CODEBUDDY_BASE_URL: 'https://example.com/v1' },
    isLogin: false
  };
  const patch = codebuddyStrategy.buildEnvPatch(ctx);
  assert.equal(patch.set.CODEBUDDY_API_KEY, 'acct-key');
  assert.equal(patch.set.CODEBUDDY_BASE_URL, 'https://example.com/v1');
  // 关键不变量：调用方先 set 后 unset，所以已注入的键绝不能被再次 unset。
  assert.equal(patch.unset.includes('CODEBUDDY_API_KEY'), false);
  assert.equal(patch.unset.includes('CODEBUDDY_BASE_URL'), false);
});

test('codebuddy launch strategy prepare pre-creates the configDir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codebuddy-strategy-'));
  try {
    codebuddyStrategy.prepare({ fs, sandboxDir: root, path });
    assert.ok(fs.statSync(path.join(root, CODEBUDDY_CONFIG_DIR_NAME)).isDirectory());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildProviderRuntimeEnv isolates a codebuddy account from host credentials', () => {
  const env = buildProviderRuntimeEnv(
    'codebuddy',
    path.join(path.sep, 'sandbox', 'cb-3'),
    {
      PATH: '/usr/bin',
      HOME: '/Users/host',
      CODEBUDDY_API_KEY: 'HOST-LEAK',
      CODEBUDDY_CONFIG_DIR: '/Users/host/.codebuddy',
      CODEBUDDY_INTERNET_ENVIRONMENT: 'internal'
    },
    {
      accountEnv: {
        CODEBUDDY_API_KEY: 'ACCOUNT-KEY',
        CODEBUDDY_BASE_URL: 'https://account.example.com/v1',
        CODEBUDDY_INTERNET_ENVIRONMENT: 'internal'
      }
    }
  );
  // 账号值胜出，宿主值被剥离。
  assert.equal(env.CODEBUDDY_API_KEY, 'ACCOUNT-KEY');
  assert.equal(env.CODEBUDDY_BASE_URL, 'https://account.example.com/v1');
  // 区域选择属于账号身份，随账号 env 透传。
  assert.equal(env.CODEBUDDY_INTERNET_ENVIRONMENT, 'internal');
  // 唯一的隔离手段：configDir 必须被改写到账号沙箱。
  assert.equal(
    env.CODEBUDDY_CONFIG_DIR,
    path.join(path.sep, 'sandbox', 'cb-3', CODEBUDDY_CONFIG_DIR_NAME)
  );
  // 共享凭据不受 configDir 控制，HOME 必须隔离；仅可重建缓存共用。
  assert.equal(env.HOME, path.join(path.sep, 'sandbox', 'cb-3'));
  assert.equal(env.CARGO_HOME, '/Users/host/.cargo');
});

test('two CodeBuddy accounts cannot read the host or each other through the shared auth path', (t) => {
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codebuddy-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = path.join('Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'probe.info');
  const homes = ['host', 'one', 'two'].map((name) => path.join(root, name));
  for (const [index, home] of homes.entries()) {
    fs.mkdirSync(path.dirname(path.join(home, relative)), { recursive: true });
    fs.writeFileSync(path.join(home, relative), `identity-${index}`);
  }
  for (const [index, home] of homes.slice(1).entries()) {
    const env = buildProviderRuntimeEnv('codebuddycn', home, {
      PATH: process.env.PATH, HOME: homes[0],
      ACC_PRODUCT_CONFIG_PATH: path.join(homes[0], 'product.json'),
      CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET: '/host/credentials.sock',
      CODEBUDDY_SIDECAR_READY_TOKEN: 'host-token', CODEBUDDY_API_KEY_DISABLED: '1'
    }, { accountEnv: {}, hostHomeDir: homes[0] });
    for (const key of ['ACC_PRODUCT_CONFIG_PATH', 'CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET',
      'CODEBUDDY_SIDECAR_READY_TOKEN', 'CODEBUDDY_API_KEY_DISABLED']) assert.equal(env[key], undefined);
    const result = execFileSync(process.execPath, ['-e',
      'process.stdout.write(require("node:fs").readFileSync(require("node:path").join(require("node:os").homedir(), process.argv[1]), "utf8"))',
      relative], { env, encoding: 'utf8' });
    assert.equal(result, `identity-${index + 1}`);
  }
});

test('buildProviderRuntimeEnv drops host API key for an OAuth codebuddy account', () => {
  const env = buildProviderRuntimeEnv(
    'codebuddy',
    path.join(path.sep, 'sandbox', 'cb-4'),
    {
      PATH: '/usr/bin',
      CODEBUDDY_API_KEY: 'HOST-LEAK',
      CODEBUDDY_INTERNET_ENVIRONMENT: 'internal'
    },
    { accountEnv: {} }
  );
  // OAuth 账号不得继承宿主的 key / 区域，否则会静默改用别人的身份与站点。
  assert.equal(env.CODEBUDDY_API_KEY, undefined);
  assert.equal(env.CODEBUDDY_INTERNET_ENVIRONMENT, undefined);
  assert.equal(
    env.CODEBUDDY_CONFIG_DIR,
    path.join(path.sep, 'sandbox', 'cb-4', CODEBUDDY_CONFIG_DIR_NAME)
  );
});

// --- 6. Desktop 启动隔离 ---
const { getDesktopLaunchStrategy } = require('../lib/server/desktop-launch');
const { resolveElectronSpawnPlan } = require('../lib/server/desktop-launch/default-strategy');

test('codebuddy Desktop inherits the default Electron user-data-dir isolation', () => {
  const strategy = getDesktopLaunchStrategy('codebuddy');
  assert.equal(strategy.name, 'default', 'no provider-specific desktop strategy is needed');
  const plan = resolveElectronSpawnPlan(
    { executablePath: '/Applications/CodeBuddy.app/Contents/MacOS/CodeBuddy' },
    { userDataDir: '/sandbox/cb-5/electron-user-data' }
  );
  assert.equal(plan.file, '/Applications/CodeBuddy.app/Contents/MacOS/CodeBuddy');
  assert.deepEqual(plan.args, ['--user-data-dir=/sandbox/cb-5/electron-user-data']);
});

// --- 7. 安装 / 卸载计划 ---
const { getAppInstaller } = require('../lib/server/app-installers');

test('codebuddy installer is discovered and exposes the official CLI plans', () => {
  const installer = getAppInstaller('codebuddy');
  assert.ok(installer, 'codebuddy installer should be discovered by the registry');
  assert.equal(installer.provider, 'codebuddy');

  const plans = installer.resolveCliInstallPlans({ platform: 'darwin', hostHomeDir: '/Users/host' });
  const ids = plans.map((plan) => plan.id);
  // 官方脚本优先（原生安装器不需要 Node），npm 全局安装兜底。
  assert.ok(ids.includes('codebuddy_posix_official'), ids.join(','));
  assert.ok(ids.includes('npm_global'), ids.join(','));
});

test('codebuddy installer uses the official Homebrew cask on macOS', () => {
  const installer = getAppInstaller('codebuddy');
  const plans = installer.resolveDesktopInstallPlans({ platform: 'darwin', hostHomeDir: '/Users/host' });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, 'homebrew_cask');
  assert.deepEqual(plans[0].args, ['install', '--cask', 'codebuddy']);
});

test('codebuddy installer covers all three binary aliases for uninstall/PATH cleanup', () => {
  const installer = getAppInstaller('codebuddy');
  assert.deepEqual(installer.listCliBinaryNames(), ['codebuddy', 'cbc', 'codebuddy-code']);
});

test('codebuddy installer degrades to a hint on Windows/Linux instead of faking URLs', () => {
  const installer = getAppInstaller('codebuddy');
  for (const platform of ['win32', 'linux']) {
    const plans = installer.resolveDesktopInstallPlans({ platform, hostHomeDir: '/Users/host' });
    assert.equal(plans.length, 0, `${platform} has no verified non-interactive installer`);
    // 没有计划时上层必须能拿到人工安装指引，且这里的 URL 是可验证的官方下载页。
    const hint = installer.buildDesktopInstallHint({ platform, hostHomeDir: '/Users/host' });
    assert.ok(hint.includes('https://www.codebuddy.ai/ide/'), hint);
  }
});

test('codebuddy installer points the macOS hint at the Homebrew cask', () => {
  const installer = getAppInstaller('codebuddy');
  const hint = installer.buildDesktopInstallHint({ platform: 'darwin', hostHomeDir: '/Users/host' });
  assert.ok(hint.includes('brew install --cask codebuddy'), hint);
});

// --- 8. 国内站（codebuddycn）与 WorkBuddy ---
//
// 站点/产品边界是本轮的核心结论，必须逐条钉住：
//   - 国内站是独立 Provider（账号体系不互通），不能与 codebuddy 共用投影根或种子前缀；
//   - WorkBuddy 是与 CodeBuddy 平行的独立产品（自己就有国内/海外两个 cask），
//     所以它是自己的 Provider，其桌面端与 kimi 的 Kimi.app 同构。

test('codebuddycn is a distinct provider with its own site identity', () => {
  assert.ok(PROVIDER_IDS.includes('codebuddycn'));
  assert.equal(isKnownProvider('codebuddycn'), true);
  const meta = getProviderMeta('codebuddycn');
  assert.equal(meta.label, 'CodeBuddy CN');
  // 图形记号必须与 codebuddy 区分，否则列表里两个站点无法一眼分辨。
  assert.notEqual(meta.terminalIcon, getProviderMeta('codebuddy').terminalIcon);
  assert.equal(meta.accentVar, 'var(--provider-codebuddycn)');
  assert.equal(meta.softVar, 'var(--provider-codebuddycn-soft)');

  const config = getProviderCLIConfig('codebuddycn');
  // 与 codebuddy 共用同一个 npm 包（同一二进制），但投影根与安装区域必须分开。
  assert.equal(config.pkg, '@tencent-ai/codebuddy-code');
  assert.equal(config.installRegion, 'cn');
  assert.notEqual(config.globalDir, getProviderCLIConfig('codebuddy').globalDir);
  assert.equal(config.globalDir, '.codebuddy-cn');
});

test('codebuddycn desktop client targets CodeBuddy CN.app and logs in independently', () => {
  const { desktopClient } = getProviderCLIConfig('codebuddycn');
  assert.ok(desktopClient, 'desktopClient should exist');
  assert.equal(desktopClient.macos.clientName, 'CodeBuddy CN');
  assert.deepEqual(desktopClient.macos.execNames, ['Electron']);
  assert.equal(desktopClient.macos.bundleId, 'com.tencent.codebuddycn');
  assert.ok(desktopClient.macos.installPaths.includes('/Applications/CodeBuddy CN.app'));
  // 凭据不通用：独立登录，不把 CLI 凭据投影进桌面端。
  assert.equal(desktopClient.reloadsHostAuth, false);
  assert.equal(desktopClient.windows, undefined);
  assert.equal(desktopClient.linux, undefined);
});

test('codebuddycn keeps the declared-platform ↔ install-plan invariant', () => {
  const installer = getAppInstaller('codebuddycn');
  assert.ok(installer, 'codebuddycn installer should be discovered');
  assert.equal(installer.provider, 'codebuddycn');
  const { desktopClient } = getProviderCLIConfig('codebuddycn');
  for (const [contractKey, installerPlatform] of [['macos', 'darwin'], ['windows', 'win32'], ['linux', 'linux']]) {
    const declared = Boolean(desktopClient[contractKey]);
    const plans = installer.resolveDesktopInstallPlans({ platform: installerPlatform, hostHomeDir: '/h' });
    assert.equal(declared, plans.length > 0, `${contractKey}: declared=${declared} plans=${plans.length}`);
  }
});

test('codebuddycn installer uses the domestic cask and the domestic CLI entry', () => {
  const installer = getAppInstaller('codebuddycn');
  const desktopPlans = installer.resolveDesktopInstallPlans({ platform: 'darwin', hostHomeDir: '/Users/host' });
  assert.equal(desktopPlans.length, 1);
  // 必须指向国内 cask：`codebuddy` 装的是国际站 App，不可互换。
  assert.deepEqual(desktopPlans[0].args, ['install', '--cask', 'codebuddy-cn']);

  const cliIds = installer
    .resolveCliInstallPlans({ platform: 'darwin', hostHomeDir: '/Users/host' })
    .map((plan) => plan.id);
  assert.ok(cliIds.includes('codebuddycn_posix_official'), cliIds.join(','));

  for (const platform of ['win32', 'linux']) {
    assert.equal(installer.resolveDesktopInstallPlans({ platform, hostHomeDir: '/h' }).length, 0);
    const hint = installer.buildDesktopInstallHint({ platform, hostHomeDir: '/h' });
    assert.ok(hint.includes('https://copilot.tencent.com/ide/'), hint);
  }
});

test('codebuddycn identity seed is namespaced by site, not shared with codebuddy', () => {
  const nativeAuth = { credentials: { oauth: { user_id: 'shared-user-7' } } };
  const seedCn = resolveNativeAuthIdentitySeed('codebuddycn', nativeAuth).identitySeed;
  const seedIntl = resolveNativeAuthIdentitySeed('codebuddy', nativeAuth).identitySeed;
  assert.ok(seedCn.startsWith('oauth:codebuddycn:user:'), seedCn);
  assert.ok(seedIntl.startsWith('oauth:codebuddy:user:'), seedIntl);
  // 同一自然人在两个站点是不同账号：种子必须不同，否则去重会把两个站点合并。
  assert.notEqual(seedCn, seedIntl);
});

test('codebuddycn storage policy cannot collide with the international root', () => {
  const cn = getProviderStoragePolicy('codebuddycn');
  assert.ok(cn, 'codebuddycn policy should exist');
  assert.deepEqual(cn.nativeRoot, ['.codebuddy-cn']);
  assert.notDeepEqual(cn.nativeRoot, getProviderStoragePolicy('codebuddy').nativeRoot);
  // hostAuthRoot 为空：共享凭据相对宿主 HOME，不属于任何 Provider 配置根。
  assert.deepEqual(cn.hostAuthRoot, []);
  const artifacts = getProviderAuthArtifacts('codebuddycn');
  assert.equal(artifacts.length, 1);
  assert.deepEqual(artifacts[0].path, CODEBUDDY_CN_SHARED_AUTH_PATH);
});

test('codebuddycn and workbuddycn share one domestic credential file and nothing else', () => {
  // 国内站 CLI 与国内站 WorkBuddy 桌面端读写同一份主站登录态：两个 Provider 声明
  // 同一个 auth artifact 就是"同一个账号"，不需要任何开关或复制逻辑。
  const cnArtifacts = getProviderAuthArtifacts('codebuddycn');
  const wbArtifacts = getProviderAuthArtifacts('workbuddycn');
  assert.deepEqual(wbArtifacts, cnArtifacts);

  // 共享面必须最小：一个凭据文件 + 一份地区级会话目录（projects）。
  // 配置/插件/私有状态仍各自投影，切账号不会互相污染。
  assert.equal(cnArtifacts.length, 1);
  assert.equal(cnArtifacts[0].field, 'credentials');
  assert.equal(cnArtifacts[0].format, 'json');
  // 实测路径：~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/
  // workbuddy-desktop.info（国内站 App 与它内嵌 CLI 的 CODEBUDDY_HOST 同名）。
  assert.deepEqual(cnArtifacts[0].path, [
    'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth',
    'workbuddy-desktop.info'
  ]);
  for (const provider of FAMILY_PROVIDERS) {
    // 共享凭据（上面已断言）+ projects（地区级会话目录，实现 work/code 打通）。
    assert.deepEqual(getProviderSharedEntries(provider), ['projects'], provider);
    assert.equal(
      getProviderStoragePolicy(provider).hostAuthRoot.length,
      0,
      `${provider}: hostAuthRoot must stay HOME-relative`
    );
  }
});

// 四个 Provider 的共享凭据文件：国内站两支共用一个，国际站两支各用一个。
const SHARED_AUTH_FILE_BY_PROVIDER = Object.freeze({
  codebuddy: 'Tencent-Cloud.coding-copilot.info',
  codebuddycn: 'workbuddy-desktop.info',
  workbuddy: 'workbuddy-desktop-ai.info',
  workbuddycn: 'workbuddy-desktop.info'
});

test('the shared credential projects into the sandbox HOME and back to the host', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codebuddy-shared-auth-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  for (const [provider, expectedFile] of Object.entries(SHARED_AUTH_FILE_BY_PROVIDER)) {
    const payload = familyCredential(provider, { uid: 'shared-user-42' });
    const accountRef = upsertAccountRef(fs, aiHomeDir, {
      provider,
      cliAccountId: '1',
      identitySeed: `oauth:${provider}:shared-user-42@example.com`
    });
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: payload });

    const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, provider, accountRef);
    assert.ok(runtimeDir, `${provider}: runtime dir must resolve`);

    const materialized = materializeProviderAuth(fs, runtimeDir, provider, { aiHomeDir, accountRef });
    assert.equal(materialized.materialized, provider === 'codebuddycn' ? 2 : 1, `${provider}: ${JSON.stringify(materialized)}`);

    // CLI 用 os.homedir() 定位凭据：沙箱里必须是同样的 HOME 相对路径。
    const relativePath = [...CODEBUDDY_EXTENSION_AUTH_DIR, expectedFile];
    const artifactPath = path.join(runtimeDir, ...relativePath);
    assert.ok(fs.existsSync(artifactPath), `${provider}: missing ${artifactPath}`);
    const projected = readProviderAuthProjection(fs, runtimeDir, provider, {});
    assert.deepEqual(projected.credentials, payload);

    // 宿主侧同步目标逐段等于声明的 HOME 相对路径（hostAuthRoot 为空）。
    assert.deepEqual(getProviderHostAuthRoot(provider), []);
    assert.deepEqual(getProviderAuthArtifacts(provider)[0].path, relativePath);
  }
});

test('every shared credential resolves from the login sandbox runtime dir', () => {
  for (const [provider, expectedFile] of Object.entries(SHARED_AUTH_FILE_BY_PROVIDER)) {
    const runtimeDir = path.join(path.sep, 'aih', 'run', 'login', provider, 'session-1');
    const expected = path.join(runtimeDir, ...CODEBUDDY_EXTENSION_AUTH_DIR, expectedFile);
    assert.equal(getOauthArtifactPath({ provider, runtimeDir }), expected, provider);
    // 没有 runtimeDir 时不猜路径。
    assert.equal(getOauthArtifactPath({ provider, runtimeDir: '' }), '', provider);
  }
});

test('codebuddycn resolves the CLI bundled inside WorkBuddy.app without installing', () => {
  const installer = getAppInstaller('codebuddycn');
  const paths = installer.collectCliPathEntries({ platform: 'darwin', hostHomeDir: '/Users/host' });
  const bundledSubpath = ['Contents', 'Resources', 'app.asar.unpacked', 'cli', 'bin'].join('/');
  assert.equal(paths[0], `/Applications/WorkBuddy.app/${bundledSubpath}`);
  assert.ok(
    paths.includes(`/Users/host/Applications/WorkBuddy.app/${bundledSubpath}`),
    paths.join(',')
  );
  // 内嵌 CLI 优先于独立安装落点，解析阶段即可命中 → 不触发任何安装计划。
  assert.ok(paths.indexOf(`/Applications/WorkBuddy.app/${bundledSubpath}`) < paths.indexOf('/Users/host/.local/bin'));

  // 只声明 macOS：WorkBuddy 没有可验证的 Windows/Linux 分发源。
  for (const platform of ['win32', 'linux']) {
    const entries = installer.collectCliPathEntries({ platform, hostHomeDir: '/Users/host' });
    assert.equal(
      entries.some((entry) => entry.includes('WorkBuddy.app')),
      false,
      `${platform}: must not invent a bundle path`
    );
  }
});

test('the bundled CLI entry stays tied to the declared WorkBuddy.app install paths', () => {
  // 内嵌 CLI 来自**国内站**的 WorkBuddy.app，所以搜索根必须对齐 workbuddycn 的
  // 安装路径声明，而不是国际站 workbuddy 的 WorkBuddy AI.app。
  const { desktopClient } = getProviderCLIConfig('workbuddycn');
  const installer = getAppInstaller('codebuddycn');
  const paths = installer.collectCliPathEntries({ platform: 'darwin', hostHomeDir: '/Users/host' });
  const bundledSubpath = ['Contents', 'Resources', 'app.asar.unpacked', 'cli', 'bin'].join('/');

  // 内嵌 CLI 的搜索根必须来自合同声明的 App 安装路径，避免两处事实漂移。
  for (const token of desktopClient.macos.installPaths) {
    const bundlePath = String(token).replace('{hostHomeDir}', '/Users/host');
    assert.ok(paths.includes(`${bundlePath}/${bundledSubpath}`), `${token} -> ${bundledSubpath}`);
  }
});

test('codebuddycn launch strategy isolates to .codebuddy-cn and pins both site keys', () => {
  const patch = codebuddyStrategy.buildEnvPatch({
    sandboxDir: path.join(path.sep, 'sandbox', 'cbcn-1'),
    path,
    baseEnv: {},
    cliName: 'codebuddycn'
  });
  assert.equal(patch.set.CODEBUDDY_CONFIG_DIR, path.join(path.sep, 'sandbox', 'cbcn-1', '.codebuddy-cn'));
  // 国内站账号必须有确定站点，否则同一密钥会随机打到国际站。
  assert.equal(patch.set.CODEBUDDY_INTERNET_ENVIRONMENT, 'internal');
  assert.equal(patch.set.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT, 'internal');
});

test('codebuddy (international) launch strategy does not guess a site', () => {
  const patch = codebuddyStrategy.buildEnvPatch({
    sandboxDir: path.join(path.sep, 'sandbox', 'cb-intl-1'),
    path,
    baseEnv: {},
    cliName: 'codebuddy'
  });
  assert.equal(patch.set.CODEBUDDY_CONFIG_DIR, path.join(path.sep, 'sandbox', 'cb-intl-1', '.codebuddy'));
  assert.equal('CODEBUDDY_INTERNET_ENVIRONMENT' in patch.set, false);
  assert.equal('CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT' in patch.set, false);
});

test('an explicit account site overrides the codebuddycn default', () => {
  const patch = codebuddyStrategy.buildEnvPatch({
    sandboxDir: path.join(path.sep, 'sandbox', 'cbcn-2'),
    path,
    baseEnv: { CODEBUDDY_INTERNET_ENVIRONMENT: 'ioa' },
    cliName: 'codebuddycn'
  });
  assert.equal(patch.set.CODEBUDDY_INTERNET_ENVIRONMENT, 'ioa');
  assert.equal(patch.set.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT, 'ioa');
});

test('the two WorkBuddy providers are desktop-only and each owns a distinct app', () => {
  // 国际站：WorkBuddy AI.app / com.workbuddy.workbuddy-ai / cask workbuddy-ai。
  assert.ok(PROVIDER_IDS.includes('workbuddy'));
  assert.deepEqual(getProviderClientSupport('workbuddy'), { cli: false, desktop: true });
  const intl = getProviderCLIConfig('workbuddy').desktopClient;
  assert.equal(intl.macos.clientName, 'WorkBuddy AI');
  assert.equal(intl.macos.bundleId, 'com.workbuddy.workbuddy-ai');
  assert.deepEqual(intl.macos.execNames, ['Electron']);
  // 实测进程 env 里真实存在的键；把它指向账号隔离目录 = 每个账号独立登录态。
  assert.equal(intl.userDataEnvKey, 'WORKBUDDY_USER_DATA_DIR');
  assert.equal(intl.reloadsHostAuth, false);
  assert.ok(intl.macos.installPaths.includes('/Applications/WorkBuddy AI.app'));

  // 国内站：WorkBuddy.app / com.tencent.workbuddy.mac / cask workbuddy-cn。
  assert.ok(PROVIDER_IDS.includes('workbuddycn'));
  assert.deepEqual(getProviderClientSupport('workbuddycn'), { cli: false, desktop: true });
  const cn = getProviderCLIConfig('workbuddycn').desktopClient;
  assert.equal(cn.macos.clientName, 'WorkBuddy');
  assert.equal(cn.macos.bundleId, 'com.tencent.workbuddy.mac');
  assert.deepEqual(cn.macos.execNames, ['Electron']);
  assert.equal(cn.userDataEnvKey, 'WORKBUDDY_USER_DATA_DIR');
  assert.equal(cn.reloadsHostAuth, false);
  assert.ok(cn.macos.installPaths.includes('/Applications/WorkBuddy.app'));

  // 两个 App 的 bundle id 与安装路径都必须不同，否则会出现"装着国际站却算成国内站"。
  assert.notEqual(intl.macos.bundleId, cn.macos.bundleId);
  assert.equal(intl.macos.installPaths.includes('/Applications/WorkBuddy.app'), false);

  for (const [provider, cask] of [
    ['workbuddy', 'workbuddy-ai'],
    ['workbuddycn', 'workbuddy-cn']
  ]) {
    const installer = getAppInstaller(provider);
    assert.ok(installer, `${provider} installer should be discovered`);
    const plans = installer.resolveDesktopInstallPlans({ platform: 'darwin', hostHomeDir: '/h' });
    assert.equal(plans.length, 1, provider);
    assert.deepEqual(plans[0].args, ['install', '--cask', cask], provider);
    // 卸载同样走同一个 cask，避免"装国际站、卸国内站"。
    const lifecycle = installer.resolveDesktopLifecyclePlans('uninstall', { platform: 'darwin', hostHomeDir: '/h' });
    const caskPlans = lifecycle.filter(plan => plan.command === 'brew');
    assert.equal(caskPlans.length, 1, provider);
    assert.deepEqual(caskPlans[0].args, ['uninstall', '--cask', cask], provider);
    const cleanup = lifecycle.find(plan => plan.args.includes('--aih-managed-path-cleanup'));
    assert.ok(cleanup, `${provider}: declared user-installed application cleanup`);
    const cleanupPayload = JSON.parse(Buffer.from(cleanup.args.at(-1), 'base64').toString('utf8'));
    assert.deepEqual(cleanupPayload.trees, [provider === 'workbuddy'
      ? '/h/Applications/WorkBuddy AI.app' : '/h/Applications/WorkBuddy.app']);
    // 不声明 CLI：WorkBuddy 不对独立分发 CLI（把 CodeBuddy runtime 内嵌在 App 内）。
    assert.equal(typeof installer.listCliBinaryNames, 'undefined', provider);
  }
});

test('workbuddy storage policies keep separate roots and separate login files', () => {
  const intl = getProviderStoragePolicy('workbuddy');
  const cn = getProviderStoragePolicy('workbuddycn');
  assert.ok(intl && cn, 'both WorkBuddy policies should exist');

  // 官方 cask 的 zap 清单与实机目录：国际站 ~/.workbuddy-ai，国内站 ~/.workbuddy。
  assert.deepEqual(intl.nativeRoot, ['.workbuddy-ai']);
  assert.deepEqual(cn.nativeRoot, ['.workbuddy']);
  // hostAuthRoot 为空：共享凭据相对宿主 HOME，不属于本 Provider 的配置根。
  assert.deepEqual(intl.hostAuthRoot, []);
  assert.deepEqual(cn.hostAuthRoot, []);

  // 登录态必须是两份不同的文件；国内站那份与 codebuddycn 共用。
  assert.deepEqual(getProviderAuthArtifacts('workbuddycn'), getProviderAuthArtifacts('codebuddycn'));
  assert.notDeepEqual(getProviderAuthArtifacts('workbuddy'), getProviderAuthArtifacts('workbuddycn'));

  for (const provider of ['workbuddy', 'workbuddycn']) {
    const privatePaths = getProviderPrivateArtifacts(provider).map((artifact) => artifact.path.join('/'));
    assert.ok(privatePaths.includes('electron-user-data'), provider);
    assert.ok(privatePaths.includes('Library/Keychains'), provider);
  }
});

test('all four family providers keep the default desktop isolation strategy', () => {
  for (const provider of FAMILY_PROVIDERS) {
    assert.equal(getDesktopLaunchStrategy(provider).name, 'default', provider);
  }
});

test('every declared terminal icon asset exists on disk with a matching brand icon', () => {
  const repoRoot = path.join(__dirname, '..');
  for (const provider of FAMILY_PROVIDERS) {
    const meta = getProviderMeta(provider);
    const assetPath = path.join(repoRoot, meta.terminalIconAsset);
    assert.ok(fs.existsSync(assetPath), `${provider}: missing ${meta.terminalIconAsset}`);
    // 生成脚本必须覆盖该 Provider，否则 PNG 会与合同声明脱节。
    const svgPath = path.join(repoRoot, 'web', 'src', 'assets', 'icons', `${provider}.svg`);
    assert.ok(fs.existsSync(svgPath), `${provider}: missing web icon ${svgPath}`);
  }
  const generator = fs.readFileSync(path.join(repoRoot, 'scripts', 'gen-provider-icons.js'), 'utf8');
  for (const provider of FAMILY_PROVIDERS) {
    assert.ok(generator.includes(`${provider}:`), `generator must cover ${provider}`);
  }
});

// --- 共享 fixture ---
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { writeAccountCredentials, writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { upsertAccountRef } = require('../lib/server/account-ref-store');

function createCodebuddyFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codebuddy-test-'));
  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });

  t.after(() => {
    accountStateIndex.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  function register(provider, cliAccountId, env) {
    const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
      provider,
      cliAccountId,
      identitySeed: `test:${provider}:${cliAccountId}:account`
    });
    if (env) writeAccountCredentials(fs, aiHomeDir, accountRef, env);
    return accountRef;
  }

  return { aiHomeDir, accountStateIndex, register };
}
