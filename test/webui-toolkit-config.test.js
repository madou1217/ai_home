'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

function createDeps(hostHomeDir) {
  return {
    fs,
    hostHomeDir,
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
    pickProjectDirectory() { return null; }
  };
}

test('webui toolkit config routes read and save an allowlisted config without returning its path', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-toolkit-config-'));
  const configDir = path.join(home, '.codex');
  const configPath = path.join(configDir, 'config.toml');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, 'model = "gpt-5"\n', 'utf8');
  const deps = createDeps(home);
  const readUrl = new URL('http://localhost/v0/webui/toolkit/apps/codex/config');
  const readRes = createResCapture();

  const readHandled = await handleWebUIRequest({
    method: 'GET',
    pathname: readUrl.pathname,
    url: readUrl,
    req: createRequest('GET', readUrl.pathname),
    res: readRes,
    deps,
    options: {},
    state: {}
  });

  assert.equal(readHandled, true);
  assert.equal(readRes.statusCode, 200);
  const readPayload = JSON.parse(readRes.body);
  assert.equal(readPayload.content, 'model = "gpt-5"\n');
  assert.equal(Object.prototype.hasOwnProperty.call(readPayload, 'path'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(readPayload, 'configPath'), false);

  const saveUrl = new URL('http://localhost/v0/webui/toolkit/apps/codex/config');
  const saveBody = JSON.stringify({
    content: 'model = "gpt-5.5"\n',
    revision: readPayload.revision
  });
  const saveRes = createResCapture();
  const saveHandled = await handleWebUIRequest({
    method: 'PUT',
    pathname: saveUrl.pathname,
    url: saveUrl,
    req: createRequest('PUT', saveUrl.pathname, saveBody),
    res: saveRes,
    deps,
    options: {},
    state: {}
  });

  assert.equal(saveHandled, true);
  assert.equal(saveRes.statusCode, 200);
  assert.equal(JSON.parse(saveRes.body).ok, true);
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'model = "gpt-5.5"\n');
});

test('webui toolkit app config routes cannot bypass discovered tool targets', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-toolkit-tool-bypass-'));
  const url = new URL('http://localhost/v0/webui/toolkit/apps/frpc/config');
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: url.pathname,
    url,
    req: createRequest('GET', url.pathname),
    res,
    deps: createDeps(home),
    options: {},
    state: {}
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'unsupported_app');
  assert.equal(fs.existsSync(path.join(home, '.config', 'frp', 'frpc.toml')), false);
});
