'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const {
  readToolPermissionSettings
} = require('../lib/cli/services/toolkit/tool-app-settings');

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

function createBaseDeps(home) {
  const aiHomeDir = path.join(home, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  return {
    fs,
    hostHomeDir: home,
    aiHomeDir,
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
    getToolConfigDir() { return path.join(home, 'tool-config'); },
    getProfileDir() { return path.join(home, 'profile'); },
    loadServerRuntimeAccounts() { return { codex: [], gemini: [], claude: [], agy: [] }; },
    applyReloadState() {},
    checkStatus() { return { configured: true }; },
    ensureSessionStoreLinks() {},
    pickProjectDirectory() { return null; }
  };
}

async function runSettingsRequest(pathname, { method = 'GET', body, deps } = {}) {
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
    deps,
    options: {},
    state: {}
  });
  return { handled, res, data: res.body ? JSON.parse(res.body) : null };
}

function withHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-tool-app-settings-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, deps: createBaseDeps(home) };
}

test('GET tool app settings returns default max permission and capability', async (t) => {
  const { deps } = withHome(t);
  const { handled, res, data } = await runSettingsRequest(
    '/v0/webui/toolkit/apps/claude/settings',
    { deps }
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(data.ok, true);
  assert.equal(data.appId, 'claude');
  assert.deepEqual(data.settings, { maxPermission: true, applyToHost: false, updatedAt: 0 });
  assert.equal(data.capability.maxSupported, true);
  assert.deepEqual(data.capability.maxArgs, ['--permission-mode', 'bypassPermissions']);
  assert.equal(data.capability.hostSupported, true);
  assert.match(data.capability.hostDisplayPath, /\.claude[/\\]settings\.json$/);
});

test('PUT tool app settings persists the per-provider switch', async (t) => {
  const { deps } = withHome(t);
  const { res, data } = await runSettingsRequest(
    '/v0/webui/toolkit/apps/claude/settings',
    {
      method: 'PUT',
      body: { maxPermission: false, applyToHost: false },
      deps
    }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(data.settings.maxPermission, false);
  assert.equal(data.settings.applyToHost, false);
  const stored = readToolPermissionSettings(fs, deps.aiHomeDir);
  assert.equal(stored.apps.claude.maxPermission, false);
});

test('PUT tool app settings applyToHost writes the verified host config', async (t) => {
  const { home, deps } = withHome(t);
  const { res, data } = await runSettingsRequest(
    '/v0/webui/toolkit/apps/claude/settings',
    {
      method: 'PUT',
      body: { maxPermission: true, applyToHost: true },
      deps
    }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(data.hostApply.applied, true);
  assert.equal(data.hostApply.changed, true);
  const hostConfig = path.join(home, '.claude', 'settings.json');
  assert.equal(fs.existsSync(hostConfig), true);
  assert.equal(JSON.parse(fs.readFileSync(hostConfig, 'utf8')).permissions.defaultMode, 'bypassPermissions');
});

test('PUT tool app settings rejects invalid payloads and unsupported hosts', async (t) => {
  const { deps } = withHome(t);

  const invalid = await runSettingsRequest('/v0/webui/toolkit/apps/claude/settings', {
    method: 'PUT',
    body: { maxPermission: 'yes', applyToHost: false },
    deps
  });
  assert.equal(invalid.res.statusCode, 400);
  assert.equal(invalid.data.error, 'invalid_permission_payload');

  const contradictory = await runSettingsRequest('/v0/webui/toolkit/apps/claude/settings', {
    method: 'PUT',
    body: { maxPermission: false, applyToHost: true },
    deps
  });
  assert.equal(contradictory.res.statusCode, 400);
  assert.equal(contradictory.data.error, 'apply_to_host_requires_max_permission');

  const unsupportedHost = await runSettingsRequest('/v0/webui/toolkit/apps/gemini/settings', {
    method: 'PUT',
    body: { maxPermission: true, applyToHost: true },
    deps
  });
  assert.equal(unsupportedHost.res.statusCode, 400);
  assert.equal(unsupportedHost.data.error, 'unsupported_app');
});

test('tool app settings route rejects unknown applications', async (t) => {
  const { deps } = withHome(t);
  const { res, data } = await runSettingsRequest(
    '/v0/webui/toolkit/apps/not-a-provider/settings',
    { deps }
  );

  assert.equal(res.statusCode, 400);
  assert.equal(data.ok, false);
  assert.equal(data.error, 'unsupported_app');
});
