'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const { createAppInstallJobManager } = require('../lib/server/app-install-job-manager');
const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeDefaultAccountRef } = require('../lib/account/default-account-store');
const { writeAccountEgressBinding } = require('../lib/account/zcode-egress-binding-store');
const { buildZcodeDesktopApplicationName } = require('../lib/runtime/account-app-process-marker');

function createResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += String(chunk);
    }
  };
}

function createRequest(method, url, body = '') {
  return {
    method,
    url,
    headers: {},
    on(event, callback) {
      if (event === 'data' && body) callback(Buffer.from(body));
      if (event === 'end') callback();
      return this;
    },
    destroy() {}
  };
}

function createBaseDeps(overrides = {}) {
  return {
    fs,
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => null,
    accountStateIndex: {
      upsertAccountState() {},
      removeAccount() {},
      getAccountState() { return null; }
    },
    getToolAccountIds() { return []; },
    getToolConfigDir() { return '/tmp/config'; },
    getProfileDir() { return '/tmp/profile'; },
    loadServerRuntimeAccounts() { return { codex: [], gemini: [], claude: [], agy: [] }; },
    applyReloadState() {},
    checkStatus() { return { configured: true }; },
    ensureSessionStoreLinks() {},
    pickProjectDirectory() { return null; },
    ...overrides
  };
}

async function runToolkitRequest(pathname, { method = 'GET', body, deps = {} } = {}) {
  const req = body === undefined
    ? new EventEmitter()
    : Readable.from([JSON.stringify(body)]);
  req.method = method;
  req.url = pathname;
  req.headers = {};
  const res = createResCapture();
  const url = new URL(`http://localhost${pathname}`);
  const handled = await handleWebUIRequest({
    method,
    pathname: url.pathname,
    url,
    req,
    res,
    deps: createBaseDeps(deps),
    options: {},
    state: {}
  });
  return { handled, res, data: res.body ? JSON.parse(res.body) : null };
}

test('webui toolkit routes GET /v0/webui/toolkit/apps returns app list', async () => {
  const req = { method: 'GET', url: '/v0/webui/toolkit/apps', headers: {} };
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/toolkit/apps',
    url: new URL('http://localhost/v0/webui/toolkit/apps'),
    req,
    res,
    deps: createBaseDeps(),
    options: {},
    state: {}
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.ok(data.apps.length > 0);
  assert.ok(data.apps.some((a) => a.id === 'claude'));
});

test('webui toolkit app install returns an async unified job instead of blocking the request', async () => {
  const result = await runToolkitRequest('/v0/webui/toolkit/apps/install', {
    method: 'POST',
    body: { appId: 'codex', confirmed: true },
    deps: {
      appInstallJobManager: {
        start(input) {
          assert.deepEqual(input, {
            appId: 'codex',
            provider: undefined,
            kind: undefined,
            confirmed: true
          });
          return {
            ok: true,
            accepted: true,
            alreadyRunning: false,
            job: {
              id: 'app-install-test',
              appId: 'codex',
              provider: 'codex',
              kind: 'cli',
              status: 'queued'
            }
          };
        }
      }
    }
  });
  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 202);
  assert.equal(result.data.accepted, true);
  assert.equal(result.data.job.id, 'app-install-test');
});

test('webui toolkit app execute rejects a request without explicit confirmation', async () => {
  const result = await runToolkitRequest('/v0/webui/toolkit/apps/install', {
    method: 'POST',
    body: { appId: 'codex', action: 'install' },
    deps: { appInstallJobManager: createAppInstallJobManager() }
  });

  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 428);
  assert.equal(result.data.error, 'confirmation_required');
});

test('webui toolkit app install preserves the account-entry Desktop target', async () => {
  let receivedInput = null;
  const result = await runToolkitRequest('/v0/webui/toolkit/apps/install', {
    method: 'POST',
    body: { appId: 'codex-desktop', action: 'install', kind: 'desktop', confirmed: true },
    deps: {
      appInstallJobManager: {
        start(input) {
          receivedInput = input;
          return {
            ok: true,
            accepted: true,
            alreadyRunning: false,
            job: {
              id: 'app-install-desktop-test',
              appId: 'codex-desktop',
              provider: 'codex',
              kind: 'desktop',
              action: 'install',
              status: 'queued'
            }
          };
        }
      }
    }
  });
  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 202);
  assert.deepEqual(receivedInput, {
    appId: 'codex-desktop',
    provider: undefined,
    kind: 'desktop',
    confirmed: true,
    action: 'install'
  });
  assert.equal(result.data.job.id, 'app-install-desktop-test');
});

test('webui toolkit app install 保留显式空 action 并返回 400', async () => {
  let installCalls = 0;
  const manager = createAppInstallJobManager({
    installCli: async () => {
      installCalls += 1;
      return { installed: true, cliPath: '/tmp/codex' };
    }
  });
  const result = await runToolkitRequest('/v0/webui/toolkit/apps/install', {
    method: 'POST',
    body: { appId: 'codex', action: '', confirmed: true },
    deps: { appInstallJobManager: manager }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 400);
  assert.equal(result.data.error, 'invalid_lifecycle_action');
  assert.equal(installCalls, 0);
});

test('webui toolkit app plan 保留显式空 action 并返回 400', async () => {
  const result = await runToolkitRequest('/v0/webui/toolkit/apps/plan', {
    method: 'POST',
    body: { appId: 'codex', action: '' },
    deps: { appInstallJobManager: createAppInstallJobManager() }
  });

  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 400);
  assert.equal(result.data.error, 'invalid_lifecycle_action');
});

test('webui toolkit opens an installed Desktop client from its application card', async () => {
  const calls = [];
  const result = await runToolkitRequest('/v0/webui/toolkit/apps/codex-desktop/open', {
    method: 'POST',
    body: {},
    deps: {
      platform: 'macos',
      processObj: { platform: 'darwin', env: {} },
      hostHomeDir: '/home/tester',
      fs: {
        existsSync(candidate) {
          return candidate === '/Applications/ChatGPT.app'
            || candidate === '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
        },
        readFileSync() {
          return '';
        }
      },
      spawn(command, args) {
        calls.push([command, args]);
        return { unref() {} };
      },
      spawnSync() {
        return { status: 1, stdout: '', stderr: '' };
      }
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.data.ok, true);
  assert.deepEqual(calls, [['open', ['-a', '/Applications/ChatGPT.app']]]);
});

test('webui toolkit Desktop open uses the Provider default account when no account is selected', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-toolkit-default-account-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'claude',
    cliAccountId: '7',
    identitySeed: 'oauth:claude:toolkit-default@example.com'
  });
  writeDefaultAccountRef(fs, aiHomeDir, 'claude', accountRef);
  const calls = [];
  const result = await runToolkitRequest('/v0/webui/toolkit/apps/claude-desktop/open', {
    method: 'POST',
    body: { action: 'close' },
    deps: {
      aiHomeDir,
      hostHomeDir: '/home/tester',
      platform: 'macos',
      processObj: { platform: 'darwin', env: {} },
      getProfileDir: () => '/tmp/claude-toolkit-profile',
      execFileSync: () => '',
      spawn(command, args) {
        calls.push([command, args]);
        return { unref() {} };
      }
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.status, 'not_running');
  assert.equal(result.data.accountRef, accountRef);
  assert.deepEqual(calls, []);
});

test('webui toolkit 复用已运行 ZCode Desktop 时不探测尚不能应用的出口', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-toolkit-zcode-egress-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '2',
    identitySeed: 'oauth:zcode:toolkit-egress@example.com'
  });
  writeDefaultAccountRef(fs, aiHomeDir, 'zcode', accountRef);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: 'url',
    proxyUrl: '127.0.0.1:10801'
  });
  let probeCalls = 0;

  const result = await runToolkitRequest('/v0/webui/toolkit/apps/zcode-desktop/open', {
    method: 'POST',
    body: {},
    deps: {
      aiHomeDir,
      processObj: { platform: 'darwin', env: { PATH: '' }, execPath: process.execPath },
      execFileSync: (file) => file === 'ps'
        ? `  9262 ${buildZcodeDesktopApplicationName(accountRef)}\n`
        : '',
      probeProxyServer: async (proxyServer) => {
        probeCalls += 1;
        assert.equal(proxyServer, '127.0.0.1:10801');
        return { ok: false, error: 'proxy_probe_failed', reason: 'curl_exit_7' };
      }
    }
  });

  assert.equal(result.handled, true);
  assert.equal(probeCalls, 0);
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.data.status, 'already_running');
  assert.match(result.data.egressWarning, /实例已运行.*出口设置.*实时应用/);
});

test('webui toolkit 已绑定代理不可达时返回 503 且不启动 ZCode', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-toolkit-zcode-egress-fail-closed-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '4',
    identitySeed: 'oauth:zcode:toolkit-egress-fail-closed@example.com'
  });
  writeDefaultAccountRef(fs, aiHomeDir, 'zcode', accountRef);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: 'url',
    proxyUrl: '127.0.0.1:10801'
  });
  const hostHomeDir = path.join(aiHomeDir, 'host-home');
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

  const result = await runToolkitRequest('/v0/webui/toolkit/apps/zcode-desktop/open', {
    method: 'POST',
    body: {},
    deps: {
      fs: fsWithVirtualApp,
      aiHomeDir,
      hostHomeDir,
      getProfileDir: () => path.join(aiHomeDir, 'zcode-profile'),
      processObj: {
        platform: 'darwin',
        env: { HOME: hostHomeDir, PATH: '' },
        execPath: process.execPath
      },
      execFileSync: () => '',
      spawn(...args) {
        spawnCalls.push(args);
        return { pid: 9980, unref() {} };
      },
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
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 503);
  assert.equal(result.data.error, 'zcode_egress_unavailable');
  assert.equal(result.data.egressError, 'proxy_unreachable');
  assert.match(result.data.message, /出口.*不可用.*未启动/);
  assert.equal(spawnCalls.length, 0);
});

test('webui toolkit 在 ZCode 原生代理设置同步失败时返回可读错误且不启动进程', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-toolkit-zcode-native-proxy-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '3',
    identitySeed: 'oauth:zcode:toolkit-native-proxy@example.com'
  });
  writeDefaultAccountRef(fs, aiHomeDir, 'zcode', accountRef);
  const hostHomeDir = path.join(aiHomeDir, 'host-home');
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

  const result = await runToolkitRequest('/v0/webui/toolkit/apps/zcode-desktop/open', {
    method: 'POST',
    body: {},
    deps: {
      fs: fsWithVirtualApp,
      aiHomeDir,
      hostHomeDir,
      getProfileDir: () => path.join(aiHomeDir, 'zcode-profile'),
      processObj: {
        platform: 'darwin',
        env: { HOME: hostHomeDir, PATH: '' },
        execPath: process.execPath
      },
      execFileSync: () => '',
      spawn(...args) {
        spawnCalls.push(args);
        return { pid: 9981, unref() {} };
      },
      prepareZcodeNativeProxySettings() {
        throw new Error('setting.json is locked');
      }
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 500);
  assert.equal(result.data.error, 'zcode_native_proxy_settings_failed');
  assert.match(result.data.message, /ZCode 原生代理设置写入失败/);
  assert.equal(spawnCalls.length, 0);
});

test('webui toolkit unscoped open bypasses the Provider default account', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-toolkit-unscoped-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'claude',
    cliAccountId: '7',
    identitySeed: 'oauth:claude:toolkit-unscoped@example.com'
  });
  writeDefaultAccountRef(fs, aiHomeDir, 'claude', accountRef);
  const calls = [];
  const result = await runToolkitRequest('/v0/webui/toolkit/apps/claude/open', {
    method: 'POST',
    body: { kind: 'cli', unscoped: true },
    deps: {
      aiHomeDir,
      hostHomeDir: '/home/tester',
      platform: 'macos',
      processObj: { platform: 'darwin', execPath: '/usr/local/bin/node', env: {} },
      resolveNativeCliPath: () => '/usr/local/bin/claude',
      spawn(command, args) {
        calls.push([command, args]);
        return { pid: 4321, unref() {} };
      }
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.accountRef, '');
  assert.equal(result.data.kind, 'cli');
  assert.equal(calls.length, 1);
  const command = calls[0][1].join(' ');
  assert.match(command, /AIH_ACCOUNT_APP=1/);
  assert.match(command, /\/usr\/local\/bin\/claude/);
  assert.doesNotMatch(command, /bin\/ai-home\.js.*claude 7/);
});

test('webui toolkit 手动检查更新只调用注入的远端检查器并返回结果', async (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-toolkit-update-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  const checkedApps = [];
  const result = await runToolkitRequest('/v0/webui/toolkit/apps/codex/check-update', {
    method: 'POST',
    deps: {
      platform: 'linux',
      hostHomeDir,
      fs,
      spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
      updateChecker: {
        async check(app) {
          checkedApps.push(app);
          return {
            ok: true,
            appId: app.id,
            provider: app.provider,
            currentVersion: null,
            latestVersion: '2.0.0',
            updateAvailable: false,
            status: 'current'
          };
        }
      }
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 200);
  assert.deepEqual(result.data, {
    ok: true,
    appId: 'codex',
    provider: 'codex',
    currentVersion: null,
    latestVersion: '2.0.0',
    updateAvailable: false,
    status: 'current'
  });
  assert.equal(checkedApps.length, 1);
  assert.equal(checkedApps[0].id, 'codex');
});

test('webui toolkit 手动检查只同步刷新被选中的应用版本', async (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-toolkit-single-version-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  const versionCalls = [];
  const checkedApps = [];
  const result = await runToolkitRequest('/v0/webui/toolkit/apps/codex/check-update', {
    method: 'POST',
    deps: {
      platform: 'linux',
      hostHomeDir,
      processObj: { platform: 'linux', env: { PATH: '' }, cwd: () => hostHomeDir },
      fs,
      resolveNativeCliPath(name) {
        return name === 'codex' ? '/opt/test-codex' : '';
      },
      spawn: () => { throw new Error('async version probe must not be used for refresh'); },
      spawnSync(command, args) {
        if (command === '/opt/test-codex' && args[0] === '--version') {
          versionCalls.push({ command, args });
          return { status: 0, stdout: 'codex 7.8.9\n', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
      },
      updateChecker: {
        async check(app) {
          checkedApps.push(app);
          return {
            ok: true,
            appId: app.id,
            provider: app.provider,
            currentVersion: app.version,
            latestVersion: '7.8.9',
            updateAvailable: false,
            status: 'current'
          };
        }
      }
    }
  });

  assert.equal(result.res.statusCode, 200);
  assert.equal(result.data.currentVersion, '7.8.9');
  assert.equal(checkedApps.length, 1);
  assert.equal(checkedApps[0].version, '7.8.9');
  assert.deepEqual(versionCalls, [{ command: '/opt/test-codex', args: ['--version'] }]);
});

test('webui toolkit 手动检查更新对不存在应用返回 404', async () => {
  const result = await runToolkitRequest('/v0/webui/toolkit/apps/not-an-app/check-update', {
    method: 'POST',
    deps: {
      platform: 'linux',
      fs,
      spawnSync: () => ({ status: 1, stdout: '', stderr: '' })
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 404);
  assert.equal(result.data.error, 'app_not_found');
});

test('webui toolkit routes GET /v0/webui/toolkit/tools returns runtime and network categories', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-toolkit-tools-'));
  const req = { method: 'GET', url: '/v0/webui/toolkit/tools', headers: {} };
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/toolkit/tools',
    url: new URL('http://localhost/v0/webui/toolkit/tools'),
    req,
    res,
    deps: createBaseDeps({
      hostHomeDir: home,
      platform: 'linux',
      resolveCommandPath(name) {
        return name === 'tmux' ? '/usr/bin/tmux' : '';
      },
      spawnSync() {
        return { status: 0, stdout: 'tmux 3.7b\n', stderr: '' };
      }
    }),
    options: {},
    state: {}
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.deepEqual(data.categories.map((category) => category.id), ['session-runtimes', 'network-access']);
  assert.ok(data.tools.some((tool) => tool.id === 'tmux'));
  assert.equal(Object.prototype.hasOwnProperty.call(data.tools[0], 'path'), false);
});

test('webui toolkit routes 为网络接入工具生成生命周期确认计划', async () => {
  const result = await runToolkitRequest('/v0/webui/toolkit/tools/plan', {
    method: 'POST',
    body: { toolId: 'frpc', action: 'install' },
    deps: {
      platform: 'linux',
      hostHomeDir: '/home/tester',
      processObj: { platform: 'linux', arch: 'x64', env: { HOME: '/home/tester', PATH: '' }, execPath: process.execPath },
      networkRuntime: {
        frpc: {
          running: false,
          executablePath: '',
          executableExists: false,
          configPath: '',
          configCount: 0,
          configState: 'none'
        }
      },
      resolveCommandPath: () => ''
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.data.action, 'install');
  assert.equal(result.data.tool.id, 'frpc');
  assert.ok(result.data.plans.every((plan) => plan.requiresConfirmation === true));
});

test('webui toolkit routes 将网络接入工具操作提交到后台任务', async () => {
  const starts = [];
  const result = await runToolkitRequest('/v0/webui/toolkit/tools/execute', {
    method: 'POST',
    body: { toolId: 'frpc', action: 'update', confirmed: true },
    deps: {
      managedToolJobManager: {
        start(input) {
          starts.push(input);
          return {
            ok: true,
            accepted: true,
            alreadyRunning: false,
            job: {
              id: 'managed-tool-action-1',
              source: 'managed-tool',
              taskName: '更新 frpc',
              appId: 'frpc',
              provider: 'frpc',
              kind: 'managed-tool',
              action: 'update',
              status: 'queued',
              phase: 'queued',
              progress: { percent: 0, label: '等待网络工具操作开始' },
              attempts: [],
              createdAt: 1,
              updatedAt: 1
            }
          };
        }
      }
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 202);
  assert.deepEqual(starts, [{ toolId: 'frpc', action: 'update', confirmed: true }]);
  assert.equal(result.data.job.source, 'managed-tool');
});

test('webui toolkit routes read a network tool config without returning its path', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-toolkit-frpc-'));
  const configPath = path.join(home, '.config', 'frp', 'frpc.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'serverAddr = "127.0.0.1"\n', 'utf8');
  const pathname = '/v0/webui/toolkit/tools/frpc/config';
  const req = { method: 'GET', url: pathname, headers: {} };
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname,
    url: new URL(`http://localhost${pathname}`),
    req,
    res,
    deps: createBaseDeps({
      hostHomeDir: home,
      platform: 'linux',
      processEntries: [],
      startupEntries: []
    }),
    options: {},
    state: {}
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.toolId, 'frpc');
  assert.equal(data.content, 'serverAddr = "127.0.0.1"\n');
  assert.match(data.targetRevision, /^[a-f0-9]{64}$/);
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'path'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'configPath'), false);
});

test('webui toolkit routes save only the discovered network tool target', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-toolkit-frpc-save-'));
  const configPath = path.join(home, '.config', 'frp', 'frpc.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'serverAddr = "before"\n', 'utf8');
  const pathname = '/v0/webui/toolkit/tools/frpc/config';
  const deps = createBaseDeps({
    hostHomeDir: home,
    platform: 'linux',
    processEntries: [],
    startupEntries: []
  });
  const readRes = createResCapture();
  await handleWebUIRequest({
    method: 'GET',
    pathname,
    url: new URL(`http://localhost${pathname}`),
    req: createRequest('GET', pathname),
    res: readRes,
    deps,
    options: {},
    state: {}
  });
  const before = JSON.parse(readRes.body);
  const body = JSON.stringify({
    content: 'serverAddr = "after"\n',
    revision: before.revision,
    targetRevision: before.targetRevision
  });
  const saveRes = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'PUT',
    pathname,
    url: new URL(`http://localhost${pathname}`),
    req: createRequest('PUT', pathname, body),
    res: saveRes,
    deps,
    options: {},
    state: {}
  });

  assert.equal(handled, true);
  assert.equal(saveRes.statusCode, 200);
  const saved = JSON.parse(saveRes.body);
  assert.equal(saved.toolId, 'frpc');
  assert.match(saved.targetRevision, /^[a-f0-9]{64}$/);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'path'), false);
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'serverAddr = "after"\n');
});

test('webui toolkit routes GET /v0/webui/toolkit/environments returns environments', async () => {
  const req = { method: 'GET', url: '/v0/webui/toolkit/environments', headers: {} };
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/toolkit/environments',
    url: new URL('http://localhost/v0/webui/toolkit/environments'),
    req,
    res,
    deps: createBaseDeps(),
    options: {},
    state: {}
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.ok(data.environments.node);
  assert.ok(data.environments.python);
});

test('webui toolkit routes GET /v0/webui/toolkit/mirrors returns mirror status', async () => {
  const req = { method: 'GET', url: '/v0/webui/toolkit/mirrors', headers: {} };
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/toolkit/mirrors',
    url: new URL('http://localhost/v0/webui/toolkit/mirrors'),
    req,
    res,
    deps: createBaseDeps(),
    options: {},
    state: {}
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.ok(data.npm);
  assert.ok(data.pip);
});

test('webui toolkit routes GET /v0/webui/toolkit/proxy returns proxy status', async () => {
  const req = { method: 'GET', url: '/v0/webui/toolkit/proxy', headers: {} };
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/toolkit/proxy',
    url: new URL('http://localhost/v0/webui/toolkit/proxy'),
    req,
    res,
    deps: createBaseDeps(),
    options: {},
    state: {}
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.ok(data.env);
  assert.ok(data.tools);
});

test('webui toolkit environment plan and execute routes enforce validation and confirmation', async () => {
  const rejected = await runToolkitRequest('/v0/webui/toolkit/environments/plan', {
    method: 'POST',
    body: { manager: 'fnm', action: 'install', version: '22; whoami' }
  });
  assert.equal(rejected.handled, true);
  assert.equal(rejected.res.statusCode, 400);
  assert.equal(rejected.data.error, 'invalid_version');

  const preview = await runToolkitRequest('/v0/webui/toolkit/environments/execute', {
    method: 'POST',
    body: { manager: 'pyenv', action: 'install', version: '3.12.7' },
    deps: { processObj: { env: {}, platform: 'linux', cwd: () => '/workspace' } }
  });
  assert.equal(preview.res.statusCode, 428);
  assert.equal(preview.data.error, 'confirmation_required');
  assert.ok(preview.data.plan);

  const executed = await runToolkitRequest('/v0/webui/toolkit/environments/execute', {
    method: 'POST',
    body: { manager: 'pyenv', action: 'install', version: '3.12.7', confirmed: true },
    deps: {
      processObj: { env: {}, platform: 'linux', cwd: () => '/workspace' },
      spawn() {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      }
    }
  });
  assert.equal(executed.res.statusCode, 200);
  assert.equal(executed.data.ok, true);
});

test('webui toolkit mirror routes use injected probes and map command failures to truthful status', async () => {
  const spawnSync = (command, args) => {
    const key = [command, ...args].join(' ');
    if (key === 'npm config get registry') return { status: 0, stdout: 'https://registry.example.test/\n', stderr: '' };
    if (key === 'pip config get global.index-url') return { status: 0, stdout: 'https://pypi.example.test/simple\n', stderr: '' };
    if (key.startsWith('npm config set registry')) return { status: 2, stdout: '', stderr: 'permission denied' };
    return { status: 1, stdout: '', stderr: 'missing' };
  };
  const status = await runToolkitRequest('/v0/webui/toolkit/mirrors', { deps: { spawnSync } });
  assert.equal(status.res.statusCode, 200);
  assert.doesNotMatch(JSON.stringify(status.data), /<URL>|<HOST>/);

  const failedWrite = await runToolkitRequest('/v0/webui/toolkit/mirrors/set', {
    method: 'POST',
    body: { type: 'npm', url: 'https://registry.example.test/' },
    deps: { spawnSync }
  });
  assert.equal(failedWrite.res.statusCode, 502);
  assert.equal(failedWrite.data.ok, false);

  const invalid = await runToolkitRequest('/v0/webui/toolkit/mirrors/set', {
    method: 'POST',
    body: { type: 'npm', url: 'file:///tmp/registry' },
    deps: { spawnSync }
  });
  assert.equal(invalid.res.statusCode, 400);
  assert.equal(invalid.data.error, 'invalid_url');
});

test('webui toolkit mirror HTTP probe returns status, TTFB measurement, and direct route', async () => {
  const result = await runToolkitRequest('/v0/webui/toolkit/mirrors/ping', {
    method: 'POST',
    body: { url: 'https://mirror.example.test/' },
    deps: { requestAdapter: async () => ({ statusCode: 304 }) }
  });
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.statusCode, 304);
  assert.equal(result.data.measurement, 'ttfb');
  assert.equal(result.data.route, 'direct');
});

test('webui toolkit proxy routes expose process scope and map write failures', async () => {
  const spawnSync = () => ({ status: 1, stdout: '', stderr: 'write failed' });
  const status = await runToolkitRequest('/v0/webui/toolkit/proxy', {
    deps: {
      processObj: { env: {}, platform: 'linux' },
      spawnSync
    }
  });
  assert.equal(status.res.statusCode, 200);
  assert.equal(status.data.env.scope, 'aih-server-process');
  assert.equal(status.data.tools.git.scope, 'global');

  const failedWrite = await runToolkitRequest('/v0/webui/toolkit/proxy/set', {
    method: 'POST',
    body: { target: 'npm', proxyUrl: 'http://127.0.0.1:7890' },
    deps: { spawnSync }
  });
  assert.equal(failedWrite.res.statusCode, 502);
  assert.equal(failedWrite.data.ok, false);
});

test('webui toolkit connectivity accepts an explicit local proxy route through injected adapter', async () => {
  const seen = [];
  const result = await runToolkitRequest('/v0/webui/toolkit/connectivity?route=proxy&proxyUrl=http%3A%2F%2Flocalhost%3A7890', {
    deps: {
      connectivityTargets: [
        { id: 'one', name: 'One', url: 'https://one.example.test', host: 'one.example.test', group: 'test' }
      ],
      requestAdapter: async (request) => {
        seen.push(request);
        return { statusCode: 401 };
      },
      systemProxy: { enabled: false, probeStatus: 'unset', source: 'test' },
      tun: { state: 'active', owner: 'clash-verge', interfaceDetected: true, routeDetected: true, evidence: ['test'] }
    }
  });

  assert.equal(result.res.statusCode, 200);
  assert.equal(result.data.route, 'proxy');
  assert.equal(result.data.proxyUsed, 'http://localhost:7890/');
  assert.equal(result.data.results[0].statusCode, 401);
  assert.equal(result.data.networkLayer.effectiveRoute, 'tun');
  assert.equal(result.data.networkLayer.tun.owner, 'clash-verge');
  assert.equal(seen[0].route, 'proxy');
});
