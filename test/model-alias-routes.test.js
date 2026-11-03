'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildModelCapabilityIndex,
  listAccountRefsForModelProvider
} = require('../lib/server/model-capability-index');
const { validateAliasRecordForSave } = require('../lib/server/model-alias-validation');
const { handleWebUiModelAliasRoutes } = require('../lib/server/webui-model-alias-routes');

const QODER_REF = 'acct_aaaaaaaaaaaaaaaaaaaa';
const ZCODE_REF = 'acct_bbbbbbbbbbbbbbbbbbbb';

function buildState() {
  return {
    accounts: {
      // qoder 先登记，模糊键 `glm-5.3-flash` 会被它的大写写法占住。
      qoder: [{ accountRef: QODER_REF, provider: 'qoder', accessToken: 'x', availableModels: ['GLM-5.3-Flash', 'Auto'] }],
      zcode: [{ accountRef: ZCODE_REF, provider: 'zcode', accessToken: 'x', availableModels: ['glm-5.3-flash'] }]
    }
  };
}

test('capability index resolves a model per provider when another provider spells it differently', () => {
  const index = buildModelCapabilityIndex(buildState(), {});
  assert.deepEqual(listAccountRefsForModelProvider(index, 'glm-5.3-flash', 'zcode'), [ZCODE_REF]);
  assert.deepEqual(listAccountRefsForModelProvider(index, 'GLM-5.3-Flash', 'qoder'), [QODER_REF]);
  // 本 provider 目录里按模糊键回退：点横 / 大小写差异仍能落到自己的账号上。
  assert.deepEqual(listAccountRefsForModelProvider(index, 'glm-5-3-flash', 'zcode'), [ZCODE_REF]);
});

test('alias validation accepts a zcode target that qoder also lists under another casing', () => {
  const state = buildState();
  const result = validateAliasRecordForSave(
    { alias: 'my-glm', target: 'glm-5.3-flash', targetProvider: 'zcode' },
    { aliases: [], state, modelCapabilityIndex: buildModelCapabilityIndex(state, {}) }
  );
  assert.equal(result.ok, true, JSON.stringify(result));
});

function createRouteHarness(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-alias-routes-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const state = buildState();
  const call = async (method, pathname, body) => {
    const res = { statusCode: 0, payload: null };
    const req = { aihBufferedBody: Buffer.from(body === undefined ? '' : JSON.stringify(body)) };
    const handled = await handleWebUiModelAliasRoutes({
      req,
      res,
      method,
      pathname,
      state,
      options: {},
      deps: {
        fs,
        aiHomeDir,
        writeJson: (target, status, payload) => { target.statusCode = status; target.payload = payload; },
        readRequestBody: async (request) => request.aihBufferedBody
      }
    });
    assert.equal(handled, true);
    return res;
  };
  return { call };
}

test('replace route keeps the old records when a new record fails validation', async (t) => {
  const { call } = createRouteHarness(t);
  const created = await call('POST', '/v0/webui/model-aliases/replace', {
    replaceIds: [],
    records: [{ alias: 'my-glm', target: 'glm-5.3-flash', targetProvider: 'zcode' }]
  });
  assert.equal(created.statusCode, 200, JSON.stringify(created.payload));
  const [record] = created.payload.aliases;

  const rejected = await call('POST', '/v0/webui/model-aliases/replace', {
    replaceIds: [record.id],
    records: [{ alias: 'my-glm', target: 'does-not-exist', targetProvider: 'zcode' }]
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.payload.error, 'alias_target_model_not_in_catalog');

  const listed = await call('GET', '/v0/webui/model-aliases');
  assert.deepEqual(listed.payload.aliases.map((alias) => alias.id), [record.id]);
});

test('replace route with no records deletes the whole group in one request', async (t) => {
  const { call } = createRouteHarness(t);
  const created = await call('POST', '/v0/webui/model-aliases/replace', {
    replaceIds: [],
    records: [
      { alias: 'my-glm', target: 'glm-5.3-flash', targetProvider: 'zcode' },
      { alias: 'my-glm', target: 'GLM-5.3-Flash', targetProvider: 'qoder' }
    ]
  });
  assert.equal(created.statusCode, 200, JSON.stringify(created.payload));
  const ids = created.payload.aliases.map((alias) => alias.id);

  const removed = await call('POST', '/v0/webui/model-aliases/replace', { replaceIds: ids, records: [] });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.payload.removed, 2);
  const listed = await call('GET', '/v0/webui/model-aliases');
  assert.deepEqual(listed.payload.aliases, []);
});
