'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');

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
    body: { appId: 'codex' },
    deps: {
      appInstallJobManager: {
        start(input) {
          assert.deepEqual(input, { appId: 'codex', provider: undefined, kind: undefined });
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

test('webui toolkit app install preserves the account-entry Desktop target', async () => {
  let receivedInput = null;
  const result = await runToolkitRequest('/v0/webui/toolkit/apps/install', {
    method: 'POST',
    body: { appId: 'codex-desktop', action: 'install', kind: 'desktop' },
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
    action: 'install'
  });
  assert.equal(result.data.job.id, 'app-install-desktop-test');
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
