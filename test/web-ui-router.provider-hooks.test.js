'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const {
  buildProviderSessionHookConfigPatch
} = require('../lib/server/provider-session-hook-config');
const {
  buildProviderSessionHookDiagnostic
} = require('../lib/server/webui-provider-hook-routes');
const { SUPPORTED_SERVER_PROVIDERS } = require('../lib/server/providers');

function createResCapture() {
  return {
    statusCode: 0,
    body: '',
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

function createBodyReader(body) {
  return async () => {
    if (body === null || body === undefined) return null;
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === 'string') return Buffer.from(body, 'utf8');
    return Buffer.from(JSON.stringify(body), 'utf8');
  };
}

async function callProviderHooksInstall(body, deps = {}) {
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/provider-hooks/install',
    url: new URL('http://localhost/v0/webui/provider-hooks/install'),
    req: {},
    res,
    options: {},
    state: {},
    deps: createBaseDeps({
      readRequestBody: createBodyReader(body),
      ...deps
    })
  });
  return {
    handled,
    statusCode: res.statusCode,
    body: JSON.parse(res.body)
  };
}

test('buildProviderSessionHookDiagnostic reports missing hook config', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-hooks-home-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const diagnostic = buildProviderSessionHookDiagnostic('claude', { fs, path, homeDir });

  assert.equal(diagnostic.provider, 'claude');
  assert.equal(diagnostic.configExists, false);
  assert.equal(diagnostic.installed, false);
  assert.deepEqual(diagnostic.missingEvents, ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd']);
});

test('buildProviderSessionHookDiagnostic reports installed generated config', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-hooks-home-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const configPath = path.join(homeDir, '.gemini', 'settings.json');
  const config = buildProviderSessionHookConfigPatch('gemini', {}, {
    homeDir,
    senderScriptPath: '/tmp/aih-hook.js'
  }).config;
  fs.ensureDirSync(path.dirname(configPath));
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  const diagnostic = buildProviderSessionHookDiagnostic('gemini', { fs, path, homeDir });

  assert.equal(diagnostic.configExists, true);
  assert.equal(diagnostic.installed, true);
  assert.deepEqual(diagnostic.missingEvents, []);
});

test('web ui provider-hooks route returns read-only diagnostics', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-hooks-home-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const codexConfig = buildProviderSessionHookConfigPatch('codex', {}, {
    homeDir,
    senderScriptPath: '/tmp/aih-hook.js'
  }).config;
  const codexPath = path.join(homeDir, '.codex', 'hooks.json');
  fs.ensureDirSync(path.dirname(codexPath));
  fs.writeFileSync(codexPath, JSON.stringify(codexConfig, null, 2), 'utf8');

  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/provider-hooks',
    url: new URL('http://localhost/v0/webui/provider-hooks'),
    req: {},
    res,
    options: {},
    state: {},
    deps: createBaseDeps({ hostHomeDir: homeDir })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.deepEqual(
    body.providers.map((item) => item.provider),
    SUPPORTED_SERVER_PROVIDERS
  );
  const byProvider = new Map(body.providers.map((item) => [item.provider, item]));
  assert.equal(byProvider.get('codex').installed, true);
  assert.equal(byProvider.get('codex').sessionSync.sourceHook.available, true);
  assert.equal(byProvider.get('codex').sessionSync.sink.available, true);
  const codexFlows = new Map(byProvider.get('codex').sessionSync.flows.map((flow) => [flow.direction, flow]));
  assert.equal(codexFlows.get('cli-to-web').status, 'available');
  assert.equal(codexFlows.get('web-to-native').status, 'conditional');
  assert.match(codexFlows.get('web-to-native').mechanism, /app-server-proxy/);
  assert.equal(codexFlows.get('native-to-web').status, 'available');
  assert.equal(byProvider.get('claude').installed, false);
  assert.equal(byProvider.get('claude').sessionSync.sourceHook.available, true);
  assert.equal(byProvider.get('claude').sessionSync.sink.available, false);
  const claudeFlows = new Map(byProvider.get('claude').sessionSync.flows.map((flow) => [flow.direction, flow]));
  assert.equal(claudeFlows.get('web-to-native').status, 'fallback');
  assert.equal(byProvider.get('gemini').installed, false);
  assert.equal(byProvider.get('gemini').sessionSync.sourceHook.available, true);
  assert.equal(byProvider.get('gemini').sessionSync.sink.available, false);
  const geminiFlows = new Map(byProvider.get('gemini').sessionSync.flows.map((flow) => [flow.direction, flow]));
  assert.equal(geminiFlows.get('web-to-native').status, 'fallback');
  assert.equal(byProvider.get('agy').installed, false);
  assert.equal(byProvider.get('agy').sessionSync.sourceHook.available, true);
  assert.equal(byProvider.get('agy').sessionSync.sink.available, false);
  const agyFlows = new Map(byProvider.get('agy').sessionSync.flows.map((flow) => [flow.direction, flow]));
  assert.equal(agyFlows.get('web-to-native').status, 'fallback');
  assert.match(agyFlows.get('cli-to-web').mechanism, /official-hooks\.json/);
  assert.equal(byProvider.get('opencode').installed, false);
});

test('web ui provider-hooks install validates payload and confirmation', async () => {
  const invalid = await callProviderHooksInstall('{bad json');
  assert.equal(invalid.handled, true);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error, 'invalid_payload');

  const noConfirm = await callProviderHooksInstall({ provider: 'gemini' });
  assert.equal(noConfirm.statusCode, 400);
  assert.equal(noConfirm.body.error, 'confirm_required');

  const noProvider = await callProviderHooksInstall({
    dryRun: true
  });
  assert.equal(noProvider.statusCode, 400);
  assert.equal(noProvider.body.error, 'provider_required');
});

test('web ui provider-hooks install dry run does not write provider config', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-hooks-home-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const configPath = path.join(homeDir, '.gemini', 'settings.json');

  const result = await callProviderHooksInstall({
    dryRun: true,
    provider: 'gemini'
  }, {
    hostHomeDir: homeDir,
    providerHookReceiverUrl: 'http://127.0.0.1:7777/v0/webui/session-events/provider-hook'
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.results.length, 1);
  assert.equal(result.body.results[0].provider, 'gemini');
  assert.equal(result.body.results[0].dryRun, true);
  assert.equal(fs.existsSync(configPath), false);
});

test('web ui provider-hooks install writes Codex hooks and feature flag after explicit confirmation', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-hooks-home-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  fs.ensureDirSync(path.dirname(configPath));
  fs.writeFileSync(configPath, '[features]\nhooks = false\n', 'utf8');

  const result = await callProviderHooksInstall({
    confirm: 'install-provider-session-hooks',
    provider: 'codex'
  }, {
    hostHomeDir: homeDir,
    providerHookReceiverUrl: 'http://127.0.0.1:7777/v0/webui/session-events/provider-hook',
    codexClientVersion: '0.137.0'
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  const hooksPath = path.join(homeDir, '.codex', 'hooks.json');
  const hooksConfig = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  const stopCommand = hooksConfig.hooks.Stop[0].hooks[0].command;
  assert.match(stopCommand, /127\.0\.0\.1:7777/);
  assert.match(fs.readFileSync(configPath, 'utf8'), /^hooks = true$/m);
});

test('web ui provider-hooks install writes Agy hookName schema after explicit confirmation', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-hooks-home-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const result = await callProviderHooksInstall({
    confirm: true,
    provider: 'agy'
  }, {
    hostHomeDir: homeDir,
    providerHookReceiverUrl: 'http://127.0.0.1:7777/v0/webui/session-events/provider-hook'
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  const hooksPath = path.join(homeDir, '.gemini', 'config', 'hooks.json');
  const hooksConfig = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  assert.equal(Boolean(hooksConfig['aih-session-sync']), true);
  assert.match(hooksConfig['aih-session-sync'].PreInvocation[0].command, /event=PreInvocation/);
});
