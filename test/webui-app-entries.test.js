'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  handleOpenAccountAppRequest,
  handleListAppEntriesRequest,
  resolveAccountAppErrorMessage,
  resolveAccountAppErrorStatus
} = require('../lib/server/webui-account-routes');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');
const { writeAccountEgressBinding } = require('../lib/account/zcode-egress-binding-store');
const {
  buildZcodeDesktopApplicationName
} = require('../lib/runtime/account-app-process-marker');

function createResCapture() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code;
    },
    end(chunk = '') {
      this.body = String(chunk);
    },
    json() {
      return JSON.parse(this.body || '{}');
    }
  };
}

function writeJson(res, code, payload) {
  res.writeHead(code);
  res.end(JSON.stringify(payload));
}

function createFixture(t, provider = 'zcode') {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-app-entries-'));
  t.after(() => {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider,
    cliAccountId: '7',
    identitySeed: `oauth:${provider}:app-entries@example.com`
  });
  assert.match(accountRef, /^acct_[a-f0-9]{20}$/);
  writeAccountCredentials(fs, aiHomeDir, accountRef, provider === 'codex'
    ? { OPENAI_API_KEY: 'fixture-key' }
    : { ZCODE_API_KEY: 'fixture-key' });
  return { aiHomeDir, accountRef, provider };
}

function createOpenAppCtx(fixture, payload) {
  return {
    pathname: `/v0/webui/accounts/${fixture.provider}/${fixture.accountRef}/open-app`,
    req: {},
    res: createResCapture(),
    fs,
    aiHomeDir: fixture.aiHomeDir,
    deps: { aiHomeDir: fixture.aiHomeDir },
    readRequestBody: async () => Buffer.from(JSON.stringify(payload)),
    getProfileDir: (provider, accountRef) => path.join(fixture.aiHomeDir, 'run', 'auth-projections', provider, accountRef),
    writeJson
  };
}

test('通用账号出口错误映射为稳定 HTTP 状态和非 ZCode 文案', () => {
  const unavailable = { error: 'account_egress_unavailable' };
  const unreadable = { error: 'account_egress_binding_unavailable' };

  assert.equal(resolveAccountAppErrorStatus(unavailable), 503);
  assert.equal(resolveAccountAppErrorStatus(unreadable), 500);
  assert.match(resolveAccountAppErrorMessage(unavailable), /账号出口.*不可用.*Desktop 未启动/);
  assert.match(resolveAccountAppErrorMessage(unreadable), /账号出口绑定.*无法读取.*客户端设置保持不变/);
  assert.doesNotMatch(resolveAccountAppErrorMessage(unavailable), /ZCode/);
  assert.doesNotMatch(resolveAccountAppErrorMessage(unreadable), /ZCode/);
});

test('open-app 端点透传 close action，无运行实例时返回 not_running', async (t) => {
  const fixture = createFixture(t);
  const ctx = createOpenAppCtx(fixture, { kind: 'desktop', action: 'close' });
  const handled = await handleOpenAccountAppRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 200);
  const body = ctx.res.json();
  assert.equal(body.ok, true);
  assert.equal(body.status, 'not_running');
  assert.deepEqual(body.pids, []);
});

test('open-app 端点对未知 action 返回 400 unsupported_action', async (t) => {
  const fixture = createFixture(t);
  const ctx = createOpenAppCtx(fixture, { kind: 'desktop', action: 'restart' });
  const handled = await handleOpenAccountAppRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 400);
  assert.equal(ctx.res.json().error, 'unsupported_action');
});

test('open-app 端点支持 cli+close，无运行实例时返回 not_running', async (t) => {
  const fixture = createFixture(t, 'codex');
  const ctx = createOpenAppCtx(fixture, { kind: 'cli', action: 'close' });
  const handled = await handleOpenAccountAppRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.res.json().status, 'not_running');
});

test('open-app 端点对缺失账号返回 404 account_not_found', async (t) => {
  const fixture = createFixture(t);
  const ctx = createOpenAppCtx(fixture, { kind: 'desktop', action: 'open' });
  ctx.pathname = '/v0/webui/accounts/zcode/acct_ffffffffffffffffffff/open-app';
  const handled = await handleOpenAccountAppRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 404);
  assert.equal(ctx.res.json().error, 'account_not_found');
});

test('open-app 端点在账号未配置时后端拒绝打开', async (t) => {
  const fixture = createFixture(t);
  writeAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef, {
    mode: 'url',
    proxyUrl: '127.0.0.1:10801'
  });
  let probeCalls = 0;
  const ctx = createOpenAppCtx(fixture, { kind: 'desktop', action: 'open' });
  ctx.accountStateIndex = { getAccountState: () => ({ configured: false }) };
  ctx.deps.probeProxyServer = async () => {
    probeCalls += 1;
    return { ok: true };
  };
  const handled = await handleOpenAccountAppRequest(ctx);
  assert.equal(handled, true);
  assert.equal(probeCalls, 0, '资格检查失败前不得等待或触发出口探测');
  assert.equal(ctx.res.statusCode, 409);
  assert.equal(ctx.res.json().error, 'account_unconfigured');
});

test('open-app 端点在账号认证失效时后端拒绝打开', async (t) => {
  const fixture = createFixture(t);
  const ctx = createOpenAppCtx(fixture, { kind: 'desktop', action: 'open' });
  ctx.accountStateIndex = {
    getAccountState: () => ({
      configured: true,
      runtimeState: {
        authInvalidUntil: Date.now() + 60_000,
        lastFailureKind: 'auth_invalid'
      }
    })
  };
  const handled = await handleOpenAccountAppRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 409);
  assert.equal(ctx.res.json().error, 'account_auth_invalid');
});

test('open-app 端点复用已运行实例时不探测尚不能应用的出口', async (t) => {
  const fixture = createFixture(t);
  writeAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef, {
    mode: 'url',
    proxyUrl: '127.0.0.1:10801'
  });
  const ctx = createOpenAppCtx(fixture, { kind: 'desktop', action: 'open' });
  ctx.processObj = { platform: 'darwin', env: { PATH: '' }, execPath: process.execPath };
  const applicationName = buildZcodeDesktopApplicationName(fixture.accountRef);
  ctx.execFileSync = (file) => file === 'ps' ? `  9261 ${applicationName}\n` : '';
  let probeCalls = 0;
  ctx.deps = {
    ...ctx.deps,
    probeProxyServer: async (proxyServer) => {
      probeCalls += 1;
      assert.equal(proxyServer, '127.0.0.1:10801');
      return { ok: false, error: 'proxy_probe_failed', reason: 'curl_exit_7' };
    }
  };

  const handled = await handleOpenAccountAppRequest(ctx);

  assert.equal(handled, true);
  assert.equal(probeCalls, 0);
  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.res.json().status, 'already_running');
  assert.match(ctx.res.json().egressWarning, /实例已运行.*出口设置.*实时应用/);
});

test('open-app 已绑定代理不可达时返回 503 且不启动 ZCode', async (t) => {
  const fixture = createFixture(t);
  writeAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef, {
    mode: 'url',
    proxyUrl: '127.0.0.1:10801'
  });
  const hostHomeDir = path.join(fixture.aiHomeDir, 'host-home');
  const bundlePath = path.join(hostHomeDir, 'Applications', 'ZCode.app');
  const executablePath = path.join(bundlePath, 'Contents', 'MacOS', 'ZCode');
  const virtualPaths = new Set([bundlePath, executablePath]);
  const fsWithVirtualApp = new Proxy(fs, {
    get(target, property) {
      if (property === 'existsSync') {
        return (candidate) => virtualPaths.has(String(candidate)) || target.existsSync(candidate);
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const spawnCalls = [];
  const ctx = createOpenAppCtx(fixture, { kind: 'desktop', action: 'open' });
  ctx.fs = fsWithVirtualApp;
  ctx.processObj = {
    platform: 'darwin',
    env: { HOME: hostHomeDir, PATH: '' },
    execPath: process.execPath
  };
  ctx.env = ctx.processObj.env;
  ctx.execFileSync = () => '';
  ctx.spawn = (...args) => {
    spawnCalls.push(args);
    return { pid: 9875, unref() {} };
  };
  ctx.deps = {
    ...ctx.deps,
    hostHomeDir,
    zcodeSingBoxRuntime: {
      ensureAccountEndpoint: async () => ({
        ok: true,
        action: 'started',
        proxyServer: '127.0.0.1:23100'
      }),
      releaseAccount: async () => ({ ok: true, action: 'stopped' })
    },
    probeProxyServer: async (proxyServer) => ({
      ok: false,
      error: 'proxy_probe_failed',
      reason: proxyServer === '127.0.0.1:23100' ? 'curl_exit_7' : 'unexpected_proxy'
    })
  };

  const handled = await handleOpenAccountAppRequest(ctx);

  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 503);
  assert.equal(ctx.res.json().error, 'zcode_egress_unavailable');
  assert.equal(ctx.res.json().egressError, 'proxy_unreachable');
  assert.match(ctx.res.json().message, /出口.*不可用.*未启动/);
  assert.equal(spawnCalls.length, 0);
});

test('open-app 遇到未知 ZCode marker 时返回 409 且不启动进程', async (t) => {
  const fixture = createFixture(t);
  const hostHomeDir = path.join(fixture.aiHomeDir, 'host-home');
  const bundlePath = path.join(hostHomeDir, 'Applications', 'ZCode.app');
  const executablePath = path.join(bundlePath, 'Contents', 'MacOS', 'ZCode');
  const virtualPaths = new Set([bundlePath, executablePath]);
  const fsWithVirtualApp = new Proxy(fs, {
    get(target, property) {
      if (property === 'existsSync') {
        return (candidate) => virtualPaths.has(String(candidate)) || target.existsSync(candidate);
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const spawnCalls = [];
  const ctx = createOpenAppCtx(fixture, { kind: 'desktop', action: 'open' });
  ctx.fs = fsWithVirtualApp;
  ctx.processObj = {
    platform: 'darwin',
    env: { HOME: hostHomeDir, PATH: '' },
    execPath: process.execPath
  };
  ctx.env = ctx.processObj.env;
  ctx.execFileSync = () => '';
  ctx.spawn = (...args) => {
    spawnCalls.push(args);
    return { pid: 9874, unref() {} };
  };
  ctx.deps = {
    ...ctx.deps,
    hostHomeDir,
    prepareZcodeNativeProxySettings() {
      return {
        ready: false,
        status: 'preserved_unrecognized_marker',
        error: 'zcode_native_proxy_marker_unrecognized',
        reason: '无法识别 ZCode 出口 marker；本次保留现有原生设置，账号出口变更未应用'
      };
    }
  };

  const handled = await handleOpenAccountAppRequest(ctx);

  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 409);
  assert.equal(ctx.res.json().error, 'zcode_native_proxy_marker_unrecognized');
  assert.match(ctx.res.json().message, /marker.*无法识别.*未启动/i);
  assert.equal(spawnCalls.length, 0);
});

test('open-app 在 ZCode 原生代理设置同步失败时返回 500 且不启动进程', async (t) => {
  const fixture = createFixture(t);
  const hostHomeDir = path.join(fixture.aiHomeDir, 'host-home');
  const bundlePath = path.join(hostHomeDir, 'Applications', 'ZCode.app');
  const executablePath = path.join(bundlePath, 'Contents', 'MacOS', 'ZCode');
  const virtualPaths = new Set([bundlePath, executablePath]);
  const fsWithVirtualApp = new Proxy(fs, {
    get(target, property) {
      if (property === 'existsSync') {
        return (candidate) => virtualPaths.has(String(candidate)) || target.existsSync(candidate);
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const spawnCalls = [];
  const ctx = createOpenAppCtx(fixture, { kind: 'desktop', action: 'open' });
  ctx.fs = fsWithVirtualApp;
  ctx.processObj = { platform: 'darwin', env: { HOME: hostHomeDir, PATH: '' }, execPath: process.execPath };
  ctx.env = ctx.processObj.env;
  ctx.execFileSync = () => '';
  ctx.spawn = (...args) => {
    spawnCalls.push(args);
    return { pid: 9876, unref() {} };
  };
  ctx.deps = {
    ...ctx.deps,
    hostHomeDir,
    prepareZcodeNativeProxySettings() {
      throw new Error('setting.json is locked');
    }
  };

  const handled = await handleOpenAccountAppRequest(ctx);

  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 500);
  assert.equal(ctx.res.json().error, 'zcode_native_proxy_settings_failed');
  assert.match(ctx.res.json().message, /ZCode 原生代理设置写入失败/);
  assert.equal(spawnCalls.length, 0);
});

test('open-app 的 ZCode Desktop 出口绑定不干预同账号 CLI 启动', async (t) => {
  const fixture = createFixture(t);
  writeAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef, {
    mode: 'url',
    proxyUrl: 'not-a-proxy-url'
  });
  const ctx = createOpenAppCtx(fixture, { kind: 'cli', action: 'open' });
  ctx.deps.hostHomeDir = path.join(fixture.aiHomeDir, 'host-home');
  ctx.deps.resolveNativeCliPath = () => '';
  ctx.processObj = { platform: 'linux', env: { PATH: '' }, execPath: process.execPath };

  const handled = await handleOpenAccountAppRequest(ctx);

  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 400);
  assert.equal(ctx.res.json().error, 'cli_not_supported');
  assert.equal(ctx.res.json().egressError, undefined);
});

test('open-app 端点在桌面缺失时返回 install_required，不在请求内阻塞安装', async (t) => {
  const fixture = createFixture(t);
  writeAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef, {
    mode: 'url',
    proxyUrl: '127.0.0.1:10801'
  });
  let probeCalls = 0;
  const ctx = createOpenAppCtx(fixture, { kind: 'desktop', action: 'open' });
  ctx.deps.probeProxyServer = async () => {
    probeCalls += 1;
    return { ok: true };
  };
  const handled = await handleOpenAccountAppRequest(ctx);
  assert.equal(handled, true);
  assert.equal(probeCalls, 0, 'Desktop 不存在时不得先探测代理');
  assert.equal(ctx.res.statusCode, 428);
  const body = ctx.res.json();
  assert.equal(body.error, 'install_required');
  assert.equal(body.installTarget.provider, 'zcode');
  assert.equal(body.installTarget.kind, 'desktop');
  assert.equal(body.installAvailable, true);
});

test('open-app 端点在 CLI 缺失时返回 install_required，并返回 CLI Toolkit 目标', async (t) => {
  const fixture = createFixture(t, 'codex');
  const ctx = createOpenAppCtx(fixture, { kind: 'cli', action: 'open' });
  ctx.deps.hostHomeDir = path.join(fixture.aiHomeDir, 'host-home');
  ctx.processObj = { platform: 'linux', env: { PATH: '' }, execPath: process.execPath };
  ctx.deps.resolveNativeCliPath = () => '';
  ctx.deps.appInstallJobManager = {
    canInstall(input) {
      assert.deepEqual(input, { provider: 'codex', kind: 'cli', appId: 'codex' });
      return true;
    }
  };

  const handled = await handleOpenAccountAppRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 428);
  const body = ctx.res.json();
  assert.equal(body.error, 'install_required');
  assert.deepEqual(body.installTarget, { provider: 'codex', kind: 'cli', appId: 'codex' });
  assert.equal(body.installAvailable, true);
});

test('open-app 端点在没有自动安装器时保留 install_required 并给出手动安装提示', async (t) => {
  const fixture = createFixture(t);
  const ctx = createOpenAppCtx(fixture, { kind: 'desktop', action: 'open' });
  ctx.deps.appInstallJobManager = { canInstall: () => false };

  const handled = await handleOpenAccountAppRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 428);
  const body = ctx.res.json();
  assert.equal(body.error, 'install_required');
  assert.equal(body.installAvailable, false);
  assert.match(body.message, /手动安装/);
});

test('app-entries 端点返回按 Provider 分组的布尔入口可用性并命中缓存', async (t) => {
  const fixture = createFixture(t);
  const ctx = {
    pathname: '/v0/webui/app-entries',
    req: {},
    res: createResCapture(),
    fs,
    aiHomeDir: fixture.aiHomeDir,
    deps: { aiHomeDir: fixture.aiHomeDir },
    writeJson
  };
  const handled = await handleListAppEntriesRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 200);
  const body = ctx.res.json();
  assert.equal(body.ok, true);
  assert.ok(body.entries && typeof body.entries === 'object');
  assert.ok(body.entries.zcode, 'zcode 必须在条目中');
  assert.equal(typeof body.entries.zcode.desktop, 'boolean');
  assert.equal(typeof body.entries.zcode.cli, 'boolean');
  assert.equal(body.capabilities.zcode.desktop, true);
  assert.equal(body.capabilities.zcode.cli, false);
  assert.equal(body.entries.kiro.desktop, false);
  assert.ok(Array.isArray(body.runningAccounts), '响应必须带 runningAccounts 数组');
});

// createAppEntriesCtx 构造可注入检测器的 app-entries 请求上下文。
function createAppEntriesCtx(fixture, appEntryDetector) {
  return {
    pathname: '/v0/webui/app-entries',
    req: {},
    res: createResCapture(),
    fs,
    aiHomeDir: fixture.aiHomeDir,
    deps: { aiHomeDir: fixture.aiHomeDir, appEntryDetector },
    getProfileDir: (provider, accountRef) => path.join(fixture.aiHomeDir, 'run', 'auth-projections', provider, accountRef),
    writeJson
  };
}

test('app-entries 端点把批量扫描命中的账号列入 runningAccounts', async (t) => {
  const fixture = createFixture(t);
  const userDataDir = path.join(
    fixture.aiHomeDir, 'run', 'auth-projections', 'zcode', fixture.accountRef, 'electron-user-data'
  );
  const ctx = createAppEntriesCtx(fixture, {
    detect: () => ({ zcode: { desktop: true, cli: false } }),
    scanRunning: () => [
      { pid: 9001, userDataDir },
      // 其它账号/应用的实例不应匹配
      { pid: 9002, userDataDir: path.join(fixture.aiHomeDir, 'run', 'auth-projections', 'zcode', 'acct_other') + path.sep + 'electron-user-data' }
    ]
  });
  const handled = await handleListAppEntriesRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 200);
  const body = ctx.res.json();
  assert.deepEqual(body.entries, { zcode: { desktop: true, cli: false } });
  assert.deepEqual(body.runningAccounts, [fixture.accountRef]);
  assert.deepEqual(body.runningAccountPids, { [fixture.accountRef]: [9001] });
  assert.deepEqual(body.runningCliAccounts, []);
  assert.deepEqual(body.runningCliAccountPids, {});
});

test('app-entries 端点在外部关闭 Desktop 后下一次扫描移除运行态', async (t) => {
  const fixture = createFixture(t);
  const userDataDir = path.join(
    fixture.aiHomeDir, 'run', 'auth-projections', 'zcode', fixture.accountRef, 'electron-user-data'
  );
  let running = [{ pid: 9001, userDataDir }];
  const detector = {
    detect: () => ({ zcode: { desktop: true, cli: false } }),
    scanRunning: () => running,
    scanRunningCli: () => []
  };
  const ctx = createAppEntriesCtx(fixture, detector);

  await handleListAppEntriesRequest(ctx);
  assert.deepEqual(ctx.res.json().runningAccountPids, { [fixture.accountRef]: [9001] });

  running = [];
  ctx.res = createResCapture();
  await handleListAppEntriesRequest(ctx);
  const body = ctx.res.json();
  assert.deepEqual(body.runningAccounts, []);
  assert.deepEqual(body.runningAccountPids, {});
});

test('app-entries 端点按 macOS ZCode application name 映射运行账号与退出状态', async (t) => {
  const fixture = createFixture(t);
  const applicationName = buildZcodeDesktopApplicationName(fixture.accountRef);
  let running = [{ pid: 9051, applicationName }];
  const detector = {
    detect: () => ({ zcode: { desktop: true, cli: false } }),
    scanRunning: () => running,
    scanRunningCli: () => []
  };
  const ctx = createAppEntriesCtx(fixture, detector);

  await handleListAppEntriesRequest(ctx);
  assert.deepEqual(ctx.res.json().runningAccountPids, { [fixture.accountRef]: [9051] });

  running = [];
  ctx.res = createResCapture();
  await handleListAppEntriesRequest(ctx);
  assert.deepEqual(ctx.res.json().runningAccountPids, {});
});

test('app-entries 端点把 marker CLI 的父子 PID 映射回 accountRef', async (t) => {
  const fixture = createFixture(t, 'codex');
  const ctx = createAppEntriesCtx(fixture, {
    detect: () => ({ codex: { desktop: false, cli: true } }),
    scanRunning: () => [],
    scanRunningCli: () => [
      {
        pid: 9101,
        provider: 'codex',
        cliAccountId: '7',
        accountRef: fixture.accountRef
      },
      {
        pid: 9102,
        provider: 'codex',
        cliAccountId: '7',
        accountRef: fixture.accountRef
      }
    ]
  });

  const handled = await handleListAppEntriesRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 200);
  const body = ctx.res.json();
  assert.deepEqual(body.runningAccounts, []);
  assert.deepEqual(body.runningAccountPids, {});
  assert.deepEqual(body.runningCliAccounts, [fixture.accountRef]);
  assert.deepEqual(body.runningCliAccountPids, { [fixture.accountRef]: [9101, 9102] });
});

test('app-entries 端点在扫描失败时降级为空 runningAccounts 且 entries 不受影响', async (t) => {
  const fixture = createFixture(t);
  const ctx = createAppEntriesCtx(fixture, {
    detect: () => ({ zcode: { desktop: true, cli: false } }),
    scanRunning: () => {
      throw new Error('scan failed');
    }
  });
  const handled = await handleListAppEntriesRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 200);
  const body = ctx.res.json();
  assert.deepEqual(body.entries, { zcode: { desktop: true, cli: false } });
  assert.deepEqual(body.runningAccounts, []);
  assert.deepEqual(body.runningAccountPids, {});
  assert.deepEqual(body.runningCliAccounts, []);
  assert.deepEqual(body.runningCliAccountPids, {});
});

test('app-entries refresh 参数使宿主检测缓存失效', async (t) => {
  const fixture = createFixture(t);
  let invalidated = 0;
  const ctx = createAppEntriesCtx(fixture, {
    invalidate: () => { invalidated += 1; },
    detect: () => ({ zcode: { desktop: false, cli: false } }),
    scanRunning: () => []
  });
  ctx.url = new URL('http://localhost/v0/webui/app-entries?refresh=1');

  const handled = await handleListAppEntriesRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 200);
  assert.equal(invalidated, 1);
});
