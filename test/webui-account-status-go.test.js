'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { handleUpdateAccountStatusRequest } = require('../lib/server/webui-account-routes');

// 非 codex/claude 的 Provider：统一写入口不能只对这两个家族生效。
const PROVIDER = 'cline';

function setupAccount(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-status-go-'));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: PROVIDER,
    cliAccountId: '1',
    identitySeed: 'cline:status-go-test'
  });
  assert.ok(accountRef);
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, { access_token: 'AT-STATUS-TEST' });
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return { aiHomeDir, accountRef };
}

async function runStatusRequest({ aiHomeDir, accountRef, status, goCoreSync, writes, stateRow }) {
  let responseStatus = 0;
  let payload = null;
  const ctx = {
    pathname: `/v0/webui/accounts/${PROVIDER}/${accountRef}/status`,
    deps: { aiHomeDir, goCoreSync },
    fs,
    state: {},
    accountStateIndex: { getAccountState: () => stateRow || null },
    accountStateService: {
      setOperationalStatus: (ref, provider, nextStatus, nextState, meta) => {
        writes.push({ kind: 'node', ref, provider, nextStatus, nextState, meta });
        if (stateRow) stateRow.status = nextStatus;
        return true;
      }
    },
    readRequestBody: async () => Buffer.from(JSON.stringify({ status })),
    checkStatus: () => ({ configured: true }),
    res: {},
    writeJson: (_res, code, body) => {
      responseStatus = code;
      payload = body;
    }
  };
  const handled = await handleUpdateAccountStatusRequest(ctx);
  return { handled, status: responseStatus, payload };
}

test('Go core 开启：任意 Provider 先写 Go，成功后再写 Node', async (t) => {
  const { aiHomeDir, accountRef } = setupAccount(t);
  const writes = [];
  const stateRow = { status: 'down' };
  const result = await runStatusRequest({
    aiHomeDir,
    accountRef,
    status: 'up',
    stateRow,
    writes,
    goCoreSync: {
      isEnabled: () => true,
      setAccountEnabled: async (nodeRef, enabled) => {
        writes.push({ kind: 'go', nodeRef, enabled });
        return { ok: true, status: 200 };
      }
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.deepEqual(writes.map((entry) => entry.kind), ['go', 'node']);
  assert.equal(writes[0].nodeRef, accountRef);
  assert.equal(writes[0].enabled, true);
  assert.equal(writes[1].nextStatus, 'up');
  assert.equal(stateRow.status, 'up');
});

test('Go core 开启：Go 写失败返回 502 且 Node account_state 不变', async (t) => {
  const { aiHomeDir, accountRef } = setupAccount(t);
  const writes = [];
  const stateRow = { status: 'up' };
  const result = await runStatusRequest({
    aiHomeDir,
    accountRef,
    status: 'down',
    stateRow,
    writes,
    goCoreSync: {
      isEnabled: () => true,
      setAccountEnabled: async (nodeRef, enabled) => {
        writes.push({ kind: 'go', nodeRef, enabled });
        return { ok: false, status: 502, errorCode: 'go_account_status_update_failed' };
      }
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.status, 502);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error, 'go_account_status_update_failed');
  assert.deepEqual(writes.map((entry) => entry.kind), ['go']);
  assert.equal(writes[0].enabled, false);
  assert.equal(stateRow.status, 'up');
});

test('Go core 关闭：只写 Node，保留纯 Node 部署模式', async (t) => {
  const { aiHomeDir, accountRef } = setupAccount(t);
  const writes = [];
  const stateRow = { status: 'down' };
  const goCalls = [];
  const result = await runStatusRequest({
    aiHomeDir,
    accountRef,
    status: 'up',
    stateRow,
    writes,
    goCoreSync: {
      isEnabled: () => false,
      setAccountEnabled: async (nodeRef, enabled) => {
        goCalls.push({ nodeRef, enabled });
        return { ok: true, status: 200 };
      }
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.deepEqual(goCalls, []);
  assert.deepEqual(writes.map((entry) => entry.kind), ['node']);
  assert.equal(writes[0].nextStatus, 'up');
  assert.equal(stateRow.status, 'up');
});
