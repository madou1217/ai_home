const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');

function createResCapture() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code;
    },
    end(chunk = '') {
      this.body = String(chunk);
    }
  };
}

test('web ui server config endpoints store config and trigger restart helper', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-server-config-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  let savedConfig = null;
  let restarted = false;
  const baseDeps = {
    fs,
    aiHomeDir,
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => null,
    accountStateIndex: {
      getAccountState() { return null; },
      upsertAccountState() {},
      removeAccount() {}
    },
    getToolAccountIds() { return []; },
    getToolConfigDir() { return '/tmp/config'; },
    getProfileDir() { return '/tmp/profile'; },
    loadServerRuntimeAccounts() { return { codex: [], gemini: [], claude: [] }; },
    applyReloadState() {},
    checkStatus() { return { configured: false, accountName: 'Unknown' }; },
    ensureSessionStoreLinks() {},
    readServerConfig() {
      return savedConfig || { host: '127.0.0.1', port: 8317, apiKey: '', managementKey: '', openNetwork: false };
    },
    writeServerConfig(config) {
      savedConfig = config;
      return savedConfig;
    },
    async restartServerWithStoredConfig() {
      restarted = true;
      return { pid: 1234, appliedConfig: savedConfig };
    }
  };

  const setRes = createResCapture();
  const setHandled = await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/server-config',
    url: new URL('http://localhost/v0/webui/server-config'),
    req: { headers: {} },
    res: setRes,
    options: {},
    state: {},
    deps: {
      ...baseDeps,
      readRequestBody: async () => Buffer.from(JSON.stringify({
        config: { host: '0.0.0.0', port: 9000, apiKey: 'x', managementKey: 'y', openNetwork: true }
      }), 'utf8')
    }
  });
  assert.equal(setHandled, true);
  assert.equal(setRes.statusCode, 200);

  const getRes = createResCapture();
  const getHandled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/server-config',
    url: new URL('http://localhost/v0/webui/server-config'),
    req: { headers: {} },
    res: getRes,
    options: {},
    state: {},
    deps: baseDeps
  });
  assert.equal(getHandled, true);
  assert.equal(JSON.parse(getRes.body).config.port, 9000);

  const restartRes = createResCapture();
  const restartHandled = await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/server/restart',
    url: new URL('http://localhost/v0/webui/server/restart'),
    req: { headers: {} },
    res: restartRes,
    options: {},
    state: {},
    deps: baseDeps
  });
  assert.equal(restartHandled, true);
  assert.equal(restarted, true);
  assert.equal(JSON.parse(restartRes.body).restarting, true);
});
