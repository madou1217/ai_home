const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');

const {
  getDesktopLaunchStrategy,
  parseDesktopInstance,
  parseDesktopInstanceName,
  resolveDesktopInstanceName,
  STRATEGY_BY_PROVIDER
} = require('../lib/server/desktop-launch');
const {
  createDesktopLaunchStrategy,
  defaultDesktopLaunchStrategy
} = require('../lib/server/desktop-launch/default-strategy');
const {
  ZCODE_DESKTOP_APPLICATION_NAME_ENV,
  buildZcodeDesktopApplicationName
} = require('../lib/runtime/account-app-process-marker');
const { ZCODE_CREDENTIAL_SECRET_ENV } = require('../lib/account/zcode-credential');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';

function buildContext(overrides = {}) {
  return {
    provider: 'x',
    account: { accountRef: ACCOUNT_REF },
    accountRef: ACCOUNT_REF,
    profileDir: '/sandbox/account',
    userDataDir: '/sandbox/account/electron-user-data',
    applicationName: '',
    platformKey: 'macos',
    path: nodePath.posix,
    aiHomeDir: '/aih',
    getBaseEnv: () => ({ HOME: '/host' }),
    deps: {},
    ...overrides
  };
}

// --- 默认策略：启动器对未注册 provider 的中性行为 ---

test('未注册 provider 落到中性默认策略：无应用名、无 env 覆写、直接执行主程序', () => {
  const strategy = getDesktopLaunchStrategy('brand-new-provider');
  assert.equal(strategy, defaultDesktopLaunchStrategy);
  const ctx = buildContext();
  assert.equal(strategy.resolveInstanceName(ctx), '');
  assert.equal(strategy.parseInstanceName('/Applications/Foo.app/Contents/MacOS/Foo'), '');

  const env = { A: '1' };
  strategy.decorateLaunchEnv(env, ctx);
  strategy.decorateResolvedLaunchEnv(env, { executablePath: '/apps/Foo', bundlePath: '/apps/Foo.app' }, ctx);
  assert.deepEqual(env, { A: '1' });

  assert.deepEqual(
    strategy.resolveSpawnPlan({ executablePath: '/apps/Foo', bundlePath: '/apps/Foo.app' }, ctx),
    { file: '/apps/Foo', args: ['--user-data-dir=/sandbox/account/electron-user-data'] }
  );
  const resolved = { executablePath: '/apps/Foo', bundlePath: '/apps/Foo.app' };
  assert.deepEqual(strategy.prepareResolvedLaunch(resolved, ctx), { ready: true, resolved });
  assert.deepEqual(strategy.prepareLaunchProfile(ctx), { ready: true });
  assert.deepEqual(strategy.prepareLaunchSession(ctx), { ready: true });
  assert.equal(strategy.reuseRunningInstance, true);
});

test('createDesktopLaunchStrategy 只覆盖声明过的钩子，其余保持中性默认', () => {
  const strategy = createDesktopLaunchStrategy({
    name: 'partial',
    resolveInstanceName: () => 'Custom-1'
  });
  const ctx = buildContext();
  assert.equal(strategy.resolveInstanceName(ctx), 'Custom-1');
  assert.deepEqual(strategy.prepareLaunchSession(ctx), { ready: true });
  assert.equal(strategy.restartFailedError, 'desktop_restart_failed');
});

// --- zcode：单实例身份 + 桌面 env 语义 ---

test('zcode 策略派生稳定应用名并写全桌面 env（数据根/凭据密钥/HOME/应用名）', () => {
  const strategy = getDesktopLaunchStrategy('zcode');
  const applicationName = buildZcodeDesktopApplicationName(ACCOUNT_REF);
  const ctx = buildContext({ provider: 'zcode', applicationName });
  assert.equal(strategy.resolveInstanceName(ctx), applicationName);

  const env = {};
  strategy.decorateLaunchEnv(env, {
    ...ctx,
    deps: { resolveZcodeCredentialSecret: (baseEnv) => `secret:${baseEnv.HOME}` }
  });
  assert.equal(env.ZCODE_DATA_BASE_DIR, '/sandbox/account');
  assert.equal(env.ZCODE_HOME, '/sandbox/account/.zcode');
  // 凭据密钥必须在宿主 env 上派生，而非沙箱 HOME。
  assert.equal(env[ZCODE_CREDENTIAL_SECRET_ENV], 'secret:/host');
  assert.equal(env.HOME, '/sandbox/account');
  assert.equal(env.USERPROFILE, undefined);
  assert.equal(env[ZCODE_DESKTOP_APPLICATION_NAME_ENV], applicationName);
});

test('zcode 策略在 macOS fresh launch 前同步账号隔离的原生代理设置', () => {
  const calls = [];
  const strategy = getDesktopLaunchStrategy('zcode');
  const result = strategy.prepareLaunchProfile(buildContext({
    provider: 'zcode',
    egressPrepared: true,
    egress: { ok: true, proxyServer: '127.0.0.1:10801' },
    fs: { tag: 'fs' },
    deps: {
      prepareZcodeNativeProxySettings(input) {
        calls.push(input);
        return { ready: true, status: 'managed' };
      }
    }
  }));

  assert.deepEqual(result, { ready: true, status: 'managed' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profileDir, '/sandbox/account');
  assert.equal(calls[0].proxyServer, '127.0.0.1:10801');
  assert.equal(calls[0].noProxy, 'localhost,127.0.0.1,::1');
});

test('zcode 策略通过独立 resolved-launch 边界准备账号影子 App', () => {
  const sourceResolved = {
    executablePath: '/Applications/ZCode.app/Contents/MacOS/ZCode',
    bundlePath: '/Applications/ZCode.app'
  };
  const shadowResolved = {
    executablePath: '/sandbox/account/.aih-runtime/zcode-shadow/ZCode.app/Contents/MacOS/ZCode',
    bundlePath: '/sandbox/account/.aih-runtime/zcode-shadow/ZCode.app'
  };
  const calls = [];
  const strategy = getDesktopLaunchStrategy('zcode');
  const result = strategy.prepareResolvedLaunch(sourceResolved, buildContext({
    provider: 'zcode',
    deps: {
      prepareZcodeElectronShadowApp(input) {
        calls.push(input);
        return { ready: true, resolved: shadowResolved, status: 'prepared' };
      }
    }
  }));

  assert.deepEqual(result, { ready: true, resolved: shadowResolved, status: 'prepared' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceBundlePath, '/Applications/ZCode.app');
  assert.equal(calls[0].profileDir, '/sandbox/account');
  assert.match(calls[0].hookModulePath, /zcode-electron-captcha-hook\.js$/);
});

test('zcode 策略只在调用方明确完成出口解析后改写或释放原生设置', () => {
  const calls = [];
  const prepareZcodeNativeProxySettings = (input) => {
    calls.push(input);
    return { ready: true, status: 'released' };
  };
  const strategy = getDesktopLaunchStrategy('zcode');

  assert.deepEqual(strategy.prepareLaunchProfile(buildContext({
    provider: 'zcode',
    egress: null,
    deps: { prepareZcodeNativeProxySettings }
  })), { ready: true });
  assert.equal(calls.length, 0, '未经过出口编排的直接调用不得清理用户配置');

  assert.deepEqual(strategy.prepareLaunchProfile(buildContext({
    provider: 'zcode',
    egressPrepared: true,
    egress: null,
    deps: { prepareZcodeNativeProxySettings }
  })), { ready: true, status: 'released' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].proxyServer, '');
});

test('parseDesktopInstanceName 从命令行反解实例身份，非改写型 provider 返回空', () => {
  const applicationName = buildZcodeDesktopApplicationName(ACCOUNT_REF);
  assert.equal(
    parseDesktopInstanceName(`/Applications/ZCode.app/Contents/MacOS/${applicationName}`),
    applicationName
  );
  assert.equal(parseDesktopInstanceName('/Applications/Kimi.app/Contents/MacOS/Kimi --user-data-dir=/x'), '');
  assert.equal(resolveDesktopInstanceName('zcode', ACCOUNT_REF), applicationName);
  assert.equal(resolveDesktopInstanceName('kimi', ACCOUNT_REF), '');
});

// --- agy：macOS 必须经 open -n 起独立实例 ---

test('agy 策略在 macOS 走 open -n bundle，其它平台回落通用 Electron 形态', () => {
  const strategy = getDesktopLaunchStrategy('agy');
  const resolved = { executablePath: '/Applications/Agy.app/Contents/MacOS/Agy', bundlePath: '/Applications/Agy.app' };
  assert.deepEqual(strategy.resolveSpawnPlan(resolved, buildContext({ provider: 'agy' })), {
    file: '/usr/bin/open',
    args: ['-n', '-a', '/Applications/Agy.app', '--args', '--user-data-dir=/sandbox/account/electron-user-data']
  });
  assert.deepEqual(
    strategy.resolveSpawnPlan(resolved, buildContext({ provider: 'agy', platformKey: 'windows' })),
    { file: resolved.executablePath, args: ['--user-data-dir=/sandbox/account/electron-user-data'] }
  );
  // agy 身份仍是 user-data-dir：原生 Keychain 全局共享，不按应用名判重。
  assert.equal(strategy.resolveInstanceName(buildContext({ provider: 'agy' })), '');
});

// --- kimi：托管登录准备 ---

test('kimi 策略种入托管 session 后要求重启已有实例', () => {
  const strategy = getDesktopLaunchStrategy('kimi');
  assert.equal(strategy.reuseRunningInstance, false);
  assert.equal(strategy.restartFailedError, 'kimi_desktop_restart_failed');

  const seeds = [];
  const result = strategy.prepareLaunchSession(buildContext({
    provider: 'kimi',
    deps: {
      readAccountCredentialRecord: () => ({
        provider: 'kimi',
        nativeAuth: { desktopSession: { accessToken: 'a', refreshToken: 'r', userId: 'u' } }
      }),
      adoptKimiDesktopTokensFromProfile: () => null,
      hasKimiDesktopTokenStore: () => false,
      seedKimiDesktopTokenStore: (payload) => { seeds.push(payload); return { seeded: true }; }
    }
  }));
  assert.equal(result.ready, true);
  assert.equal(result.requiresRestart, true);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].refreshToken, 'r');
});

test('kimi 策略无可用 session 且无既有 token 仓时关闭启动', () => {
  const result = getDesktopLaunchStrategy('kimi').prepareLaunchSession(buildContext({
    provider: 'kimi',
    deps: {
      readAccountCredentialRecord: () => ({ provider: 'kimi', nativeAuth: {} }),
      adoptKimiDesktopTokensFromProfile: () => null,
      hasKimiDesktopTokenStore: () => false,
      seedKimiDesktopTokenStore: () => ({ seeded: false })
    }
  }));
  assert.deepEqual(result, { ready: false, error: 'kimi_desktop_session_required' });
});

test('kimi 策略：注入实现抛错时降级为可诊断的失败，不冒泡到启动器', () => {
  const result = getDesktopLaunchStrategy('kimi').prepareLaunchSession(buildContext({
    provider: 'kimi',
    deps: {
      readAccountCredentialRecord: () => ({ provider: 'kimi', nativeAuth: {} }),
      adoptKimiDesktopTokensFromProfile: () => { throw new Error('profile locked'); }
    }
  }));
  assert.equal(result.ready, false);
  assert.equal(result.error, 'kimi_desktop_session_seed_failed');
  assert.match(result.reason, /profile locked/);
});

// --- 注册表契约 ---

test('实例身份必须由唯一 provider 认领：撞车时返回空而不是按注册顺序猜', () => {
  // 每个会改写命令行的 provider，其派生出的身份只能被自己认领。撞车会让运行态
  // 归错账号、close 杀错进程，因此把"唯一认领"写成注册表契约在测试期拦住。
  for (const [provider, strategy] of Object.entries(STRATEGY_BY_PROVIDER)) {
    const name = strategy.resolveInstanceName(buildContext({ provider, accountRef: ACCOUNT_REF }));
    if (!name) continue;
    const commandLine = `/Applications/App.app/Contents/MacOS/${name}`;
    const claimants = Object.entries(STRATEGY_BY_PROVIDER)
      .filter(([, candidate]) => String(candidate.parseInstanceName(commandLine) || '').trim());
    assert.deepEqual(claimants.map(([id]) => id), [provider], `${provider} 的实例身份被多家认领`);
    assert.deepEqual(parseDesktopInstance(commandLine), { provider, name });
  }
});

test('注册表内每个策略都满足完整的策略契约', () => {
  for (const [provider, strategy] of Object.entries(STRATEGY_BY_PROVIDER)) {
    assert.equal(typeof strategy.name, 'string', provider);
    for (const hook of [
      'resolveInstanceName',
      'parseInstanceName',
      'decorateLaunchEnv',
      'decorateResolvedLaunchEnv',
      'prepareResolvedLaunch',
      'resolveSpawnPlan',
      'prepareLaunchProfile',
      'prepareLaunchSession'
    ]) {
      assert.equal(typeof strategy[hook], 'function', `${provider}.${hook}`);
    }
    assert.equal(typeof strategy.reuseRunningInstance, 'boolean', provider);
    assert.equal(typeof strategy.restartFailedError, 'string', provider);
  }
});
