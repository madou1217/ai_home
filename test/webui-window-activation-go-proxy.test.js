'use strict';

// POST /v0/webui/accounts/:provider/:ref/window-activation 固定写 Go：
// Node 保留 provider/时长的运行时校验，并在写成功后读回配置组装调度器视图。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { handleWindowActivationRequest } = require('../lib/server/webui-window-activation-routes');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';

function setup() {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-window-activation-'));
  const db = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
  db.exec('CREATE TABLE account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
  db.prepare('INSERT INTO account_refs VALUES (?, ?, 1, 1)').run(ACCOUNT_REF, 'codex');
  db.close();
  return aiHomeDir;
}

async function call(options = {}) {
  const aiHomeDir = options.aiHomeDir || setup();
  const calls = [];
  let captured;
  const deps = {
    readWindowActivationConfig: () => ({ enabled: true, intervalMs: 7200000, updatedAt: 1 }),
    readWindowActivationState: () => null,
    readServerConfig: () => ({}),
    getWindowActivationState: () => null
  };
  if (options.goResponse !== undefined) {
    deps.goCoreSync = {
      saveWindowActivationConfig: async (provider, accountRef, payload) => {
        calls.push({ provider, accountRef, payload });
        return options.goResponse;
      }
    };
  }
  const ctx = {
    method: 'POST',
    pathname: '/v0/webui/accounts/codex/' + ACCOUNT_REF + '/window-activation',
    url: new URL('http://127.0.0.1/v0/webui/accounts/codex/' + ACCOUNT_REF + '/window-activation'),
    fs,
    aiHomeDir,
    deps,
    res: {},
    readRequestBody: async () => Buffer.from(options.body === undefined ? '{"enabled":true,"intervalMs":7200000}' : options.body, 'utf8'),
    writeJson: (_res, status, payload) => { captured = { status, payload }; }
  };
  const handled = await handleWindowActivationRequest(ctx);
  return { handled, captured, calls, aiHomeDir };
}

test('窗口激活 POST：写 Go 并读回配置组装响应', async () => {
  const result = await call({ goResponse: { ok: true, status: 200, data: { ok: true } } });
  assert.equal(result.captured.status, 200);
  assert.equal(result.captured.payload.setting.enabled, true);
  assert.equal(result.captured.payload.setting.intervalMs, 7200000);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0], {
    provider: 'codex',
    accountRef: ACCOUNT_REF,
    payload: { enabled: true, intervalMs: 7200000, minIntervalMs: 3600000 }
  });
});

test('窗口激活 POST：缺少 Go 宿主时 503，不本地写', async () => {
  const result = await call();
  assert.equal(result.captured.status, 503);
  assert.equal(result.captured.payload.error, 'go_core_unavailable');
});

test('窗口激活 POST：间隔低于下限 400，不调用 Go', async () => {
  const result = await call({ body: '{"enabled":true,"intervalMs":1000}', goResponse: { ok: true, status: 200, data: { ok: true } } });
  assert.equal(result.captured.status, 400);
  assert.equal(result.captured.payload.error, 'invalid_interval_ms');
  assert.equal(result.calls.length, 0);
});
