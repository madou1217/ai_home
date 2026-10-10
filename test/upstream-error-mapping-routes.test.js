'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const { createAccountStateIndex } = require('../lib/account/state-index');
const {
  readAccountCredentials,
  readAccountCredentialRecord,
  writeAccountCredentials
} = require('../lib/server/account-credential-store');
const { loadServerRuntimeAccounts } = require('../lib/server/accounts');
const { handleWebUiUpstreamErrorMappingRoutes } = require('../lib/server/webui-upstream-error-mapping-routes');

const balanceRule = {
  name: '余额不足',
  enabled: true,
  statuses: [403],
  kind: 'billing_blocked',
  matchers: [{ source: 'json', path: 'error.code', operator: 'equals', value: 'insufficient_user_quota' }]
};

function responseCapture() {
  return {
    statusCode: 0,
    body: '',
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(body = '') { this.body = String(body); }
  };
}

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-upstream-error-mappings-'));
  const accountStateIndex = createAccountStateIndex({ fs, aiHomeDir });
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '71',
    identitySeed: 'test:codex:mapping-routes'
  });
  const accountRef = registration.accountRef;
  writeAccountCredentials(fs, aiHomeDir, accountRef, {
    OPENAI_API_KEY: 'fixture-api-key',
    OPENAI_BASE_URL: 'https://upstream.example.test/v1'
  });
  const state = { accounts: {}, modelAccountIndex: null, webUiModelsCache: {} };
  let loaded = null;
  const load = (args) => {
    loaded = loadServerRuntimeAccounts({
      ...args,
      fs,
      aiHomeDir,
      accountStateIndex,
      getProfileDir: () => '',
      checkStatus: () => ({ configured: true })
    });
    return loaded;
  };
  const apply = (_state, runtimeAccounts) => {
    state.accounts = runtimeAccounts;
  };
  const call = async (method, pathname, payload, overrides = {}) => {
    const res = responseCapture();
    await handleWebUiUpstreamErrorMappingRoutes({
      method,
      pathname,
      req: {},
      res,
      fs,
      aiHomeDir,
      state,
      accountStateIndex,
      loadServerRuntimeAccounts: load,
      applyReloadState: apply,
      readRequestBody: async () => Buffer.from(payload === undefined ? '' : JSON.stringify(payload)),
      writeJson: (_res, statusCode, body) => {
        res.statusCode = statusCode;
        res.end(JSON.stringify(body));
      },
      deps: { aiHomeDir },
      ...overrides
    });
    return { statusCode: res.statusCode, body: JSON.parse(res.body || '{}') };
  };
  t.after(() => {
    accountStateIndex.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  return { aiHomeDir, accountRef, state, call, loaded: () => loaded };
}

test('mapping groups support CRUD, immutable resource ids, provider filtering and account attachment', async (t) => {
  const fixture = createFixture(t);
  const created = await fixture.call('POST', '/v0/webui/upstream-error-mappings', {
    name: 'New API 余额不足', provider: 'codex', enabled: true, rules: [balanceRule]
  });
  assert.equal(created.statusCode, 200);
  const group = created.body.group;
  assert.match(group.id, /^uem_[a-f0-9]+$/);

  const record = readAccountCredentialRecord(fs, fixture.aiHomeDir, fixture.accountRef);
  writeAccountCredentials(fs, fixture.aiHomeDir, fixture.accountRef, {
    ...record.env,
    AIH_UPSTREAM_ERROR_GROUP_IDS: JSON.stringify([group.id])
  });

  const updated = await fixture.call('PUT', `/v0/webui/upstream-error-mappings/${group.id}`, {
    id: 'attacker-controlled-id',
    name: 'New API 余额不足（更新）',
    provider: 'codex',
    rules: [balanceRule]
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.group.id, group.id);
  assert.equal(fixture.loaded().codex[0].upstreamErrorRules[0].kind, 'billing_blocked');

  const providerMismatch = await fixture.call('PUT', `/v0/webui/upstream-error-mappings/${group.id}`, {
    name: 'Gemini only', provider: 'gemini', rules: [balanceRule]
  });
  assert.equal(providerMismatch.statusCode, 200);
  assert.deepEqual(fixture.loaded().codex[0].upstreamErrorRules, []);

  const toggled = await fixture.call('POST', `/v0/webui/upstream-error-mappings/${group.id}/toggle`);
  assert.equal(toggled.statusCode, 200);
  assert.equal(toggled.body.group.enabled, false);
  assert.deepEqual(fixture.loaded().codex[0].upstreamErrorRules, []);

  const deleted = await fixture.call('DELETE', `/v0/webui/upstream-error-mappings/${group.id}`);
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(fixture.loaded().codex[0].upstreamErrorRules, []);
  assert.equal(readAccountCredentials(fs, fixture.aiHomeDir, fixture.accountRef).AIH_UPSTREAM_ERROR_GROUP_IDS, JSON.stringify([group.id]));
});

test('mapping group updates reload the active account pool without clearing existing model cache', async (t) => {
  const fixture = createFixture(t);
  fixture.state.webUiModelsCache = {
    byAccount: { [fixture.accountRef]: ['fixture-model'] },
    byProvider: { codex: ['fixture-model'] },
    updatedAt: 123
  };
  const created = await fixture.call('POST', '/v0/webui/upstream-error-mappings', {
    name: 'Codex rule', provider: 'codex', rules: [balanceRule]
  });
  assert.equal(created.statusCode, 200);
  assert.deepEqual(fixture.state.webUiModelsCache.byAccount[fixture.accountRef], ['fixture-model']);
  assert.deepEqual(fixture.state.webUiModelsCache.byProvider.codex, ['fixture-model']);
});

test('invalid JSON cannot silently succeed and simultaneous group creations preserve both records', async (t) => {
  const fixture = createFixture(t);
  const payload = { name: 'first', provider: 'codex', rules: [balanceRule] };
  const created = await fixture.call('POST', '/v0/webui/upstream-error-mappings', payload);
  const id = created.body.group.id;
  const invalid = await fixture.call('PUT', `/v0/webui/upstream-error-mappings/${id}`, undefined, {
    readRequestBody: async () => Buffer.from('{')
  });
  assert.equal(invalid.statusCode, 400);
  const wrongPath = await fixture.call('DELETE', `/v0/webui/upstream-error-mappings/${id}/toggle`);
  assert.equal(wrongPath.statusCode, 405);

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = fixture.call('POST', '/v0/webui/upstream-error-mappings', undefined, {
    readRequestBody: async () => { await gate; return Buffer.from(JSON.stringify({ ...payload, name: 'second' })); }
  });
  const second = await fixture.call('POST', '/v0/webui/upstream-error-mappings', { ...payload, name: 'third' });
  release();
  assert.equal(second.statusCode, 200);
  assert.equal((await first).statusCode, 200);
  const listed = await fixture.call('GET', '/v0/webui/upstream-error-mappings');
  assert.deepEqual(listed.body.groups.map(group => group.name).sort(), ['first', 'second', 'third']);
});
