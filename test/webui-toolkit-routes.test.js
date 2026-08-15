'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');

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
    deps: createBaseDeps({ hostHomeDir: home, platform: 'linux' }),
    options: {},
    state: {}
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.toolId, 'frpc');
  assert.equal(data.content, 'serverAddr = "127.0.0.1"\n');
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'path'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'configPath'), false);
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
