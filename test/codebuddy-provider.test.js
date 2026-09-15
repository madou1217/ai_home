'use strict';

/**
 * CodeBuddy Provider 集成契约测试。
 *
 * 覆盖本轮集成的四条边界（静态定义 / 账号身份 / 存储与启动隔离 / 安装启动），
 * 每条边界都对齐本仓库既有的 per-provider 约定。这里只断言"声明的事实"，不
 * 复述实现细节，避免测试变成实现的第二份副本。
 *
 * 范围边界（刻意不覆盖）：网关路由、用量探测、会话历史、原生聊天均未接入
 * CodeBuddy，因此没有任何相关断言——一旦将来接入，应先补实现再补这里的断言。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
test('codebuddy declares only api_key_account (no unimplemented capabilities)', () => {
  assert.equal(providerSupports('codebuddy', 'api_key_account'), true);
  for (const capability of [
    'model_catalog',
    'quota_usage',
    'session_runtime',
    'fabric_runtime',
    'gateway_profile',
    'session_history',
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
  getProviderStoragePolicy,
  getProviderAuthArtifacts,
  getProviderPrivateArtifacts,
  getProviderPrivateEntryNames,
  getProviderSharedEntries
} = require('../lib/runtime/provider-storage-policy');

test('codebuddy storage policy roots at .codebuddy and isolates account-private state', () => {
  const policy = getProviderStoragePolicy('codebuddy');
  assert.ok(policy, 'codebuddy policy should exist');
  assert.deepEqual(policy.nativeRoot, ['.codebuddy']);
  assert.deepEqual(policy.hostAuthRoot, ['.codebuddy']);

  // 本轮不与宿主共享任何目录：CLI 完全读 configDir，共享需要额外的链接器。
  assert.deepEqual(getProviderSharedEntries('codebuddy'), []);

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

test('codebuddy captures the native credential file as the auth artifact', () => {
  const artifacts = getProviderAuthArtifacts('codebuddy');
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].field, 'credentials');
  assert.deepEqual(artifacts[0].path, ['.codebuddy', '.credentials.json']);
  assert.equal(artifacts[0].format, 'json');
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
  // hostAuthRoot 刻意不共用 ~/.codebuddy：那个目录无法归因到具体站点。
  assert.deepEqual(cn.hostAuthRoot, ['.codebuddy-cn']);
  assert.notDeepEqual(cn.nativeRoot, getProviderStoragePolicy('codebuddy').nativeRoot);
  const artifacts = getProviderAuthArtifacts('codebuddycn');
  assert.equal(artifacts.length, 1);
  assert.deepEqual(artifacts[0].path, ['.codebuddy-cn', '.credentials.json']);
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

test('workbuddy is desktop-only and owns its own user-data isolation key', () => {
  assert.ok(PROVIDER_IDS.includes('workbuddy'));
  assert.deepEqual(getProviderClientSupport('workbuddy'), { cli: false, desktop: true });

  const { desktopClient } = getProviderCLIConfig('workbuddy');
  assert.equal(desktopClient.macos.clientName, 'WorkBuddy');
  assert.equal(desktopClient.macos.bundleId, 'com.tencent.workbuddy.mac');
  assert.deepEqual(desktopClient.macos.execNames, ['Electron']);
  // 实测进程 env 里真实存在的键；把它指向账号隔离目录 = 每个账号独立登录态。
  assert.equal(desktopClient.userDataEnvKey, 'WORKBUDDY_USER_DATA_DIR');
  assert.equal(desktopClient.reloadsHostAuth, false);

  const installer = getAppInstaller('workbuddy');
  assert.ok(installer, 'workbuddy installer should be discovered');
  const plans = installer.resolveDesktopInstallPlans({ platform: 'darwin', hostHomeDir: '/h' });
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].args, ['install', '--cask', 'workbuddy-cn']);
  // 国内站的 App 是 WorkBuddy.app；workbuddy-ai 装的是另一个 App，不可互换。
  assert.ok(desktopClient.macos.installPaths.includes('/Applications/WorkBuddy.app'));
  // 不声明 CLI：WorkBuddy 不对独立分发 CLI（把 CodeBuddy runtime 内嵌在 App 内）。
  assert.equal(typeof installer.listCliBinaryNames, 'undefined');
});

test('workbuddy storage policy does not claim a credential file that does not exist', () => {
  const policy = getProviderStoragePolicy('workbuddy');
  assert.ok(policy, 'workbuddy policy should exist');
  assert.deepEqual(policy.nativeRoot, ['.workbuddy']);
  assert.deepEqual(policy.hostAuthRoot, ['.workbuddy']);
  // 登录态在 Electron userData + Keychain 内，没有可移植凭据文件。
  assert.deepEqual(getProviderAuthArtifacts('workbuddy'), []);
  const privatePaths = getProviderPrivateArtifacts('workbuddy').map((artifact) => artifact.path.join('/'));
  assert.ok(privatePaths.includes('electron-user-data'));
  assert.ok(privatePaths.includes('Library/Keychains'));
});

test('all three family providers keep the default desktop isolation strategy', () => {
  for (const provider of ['codebuddy', 'codebuddycn', 'workbuddy']) {
    assert.equal(getDesktopLaunchStrategy(provider).name, 'default', provider);
  }
});

test('every declared terminal icon asset exists on disk with a matching brand icon', () => {
  const repoRoot = path.join(__dirname, '..');
  for (const provider of ['codebuddy', 'codebuddycn', 'workbuddy']) {
    const meta = getProviderMeta(provider);
    const assetPath = path.join(repoRoot, meta.terminalIconAsset);
    assert.ok(fs.existsSync(assetPath), `${provider}: missing ${meta.terminalIconAsset}`);
    // 生成脚本必须覆盖该 Provider，否则 PNG 会与合同声明脱节。
    const svgPath = path.join(repoRoot, 'web', 'src', 'assets', 'icons', `${provider}.svg`);
    assert.ok(fs.existsSync(svgPath), `${provider}: missing web icon ${svgPath}`);
  }
  const generator = fs.readFileSync(path.join(repoRoot, 'scripts', 'gen-provider-icons.js'), 'utf8');
  for (const provider of ['codebuddy', 'codebuddycn', 'workbuddy']) {
    assert.ok(generator.includes(`${provider}:`), `generator must cover ${provider}`);
  }
});

// --- 共享 fixture ---
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');

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
