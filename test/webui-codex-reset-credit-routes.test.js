'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let subject = {};
try {
  subject = require('../lib/server/webui-codex-reset-credit-routes');
} catch (_error) {}

const { handleWebUiCodexResetCreditRoutes } = subject;
const ACCOUNT_REF = 'acct_11111111111111111111';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';

function createContext(method, pathname, payload, service) {
  const writes = [];
  const headers = {};
  return {
    writes,
    headers,
    context: {
      method,
      pathname,
      req: {},
      res: {
        setHeader(name, value) {
          headers[String(name).toLowerCase()] = value;
        }
      },
      readRequestBody: async () => payload === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(payload)),
      writeJson(_res, statusCode, body) {
        writes.push({ statusCode, body });
      },
      deps: { codexResetCreditService: service }
    }
  };
}

test('lists Codex reset-card inventory and history without adding account-list fields', async () => {
  assert.equal(typeof handleWebUiCodexResetCreditRoutes, 'function');
  const calls = [];
  const response = {
    accountRef: ACCOUNT_REF,
    availableCount: 1,
    selectableCount: 1,
    detailsComplete: true,
    inventoryVersion: 'inventory-version',
    credits: [{ creditId: 'credit-a', status: 'available' }]
  };
  const request = createContext(
    'GET',
    `/v0/webui/accounts/codex/${ACCOUNT_REF}/reset-credits`,
    undefined,
    {
      async list(accountRef) {
        calls.push(accountRef);
        return response;
      }
    }
  );

  assert.equal(await handleWebUiCodexResetCreditRoutes(request.context), true);
  assert.deepEqual(calls, [ACCOUNT_REF]);
  assert.deepEqual(request.writes, [{ statusCode: 200, body: { ok: true, ...response } }]);
  assert.equal(request.headers['cache-control'], 'no-store');
});

test('forwards the stable operation id and inventory version to consume', async () => {
  const calls = [];
  const operation = { operationId: OPERATION_ID, status: 'unknown' };
  const request = createContext(
    'POST',
    `/v0/webui/accounts/codex/${ACCOUNT_REF}/reset-credits/consume`,
    { operationId: OPERATION_ID, inventoryVersion: 'inventory-version' },
    {
      async consume(input) {
        calls.push(input);
        return { operation, reconciliationRequired: true };
      }
    }
  );

  assert.equal(await handleWebUiCodexResetCreditRoutes(request.context), true);
  assert.deepEqual(calls, [{
    accountRef: ACCOUNT_REF,
    operationId: OPERATION_ID,
    inventoryVersion: 'inventory-version'
  }]);
  assert.deepEqual(request.writes, [{
    statusCode: 202,
    body: { ok: true, operation, reconciliationRequired: true }
  }]);
});

test('reconciles an unknown operation through an explicit route and maps conflicts', async () => {
  const queried = createContext(
    'GET',
    `/v0/webui/accounts/codex/${ACCOUNT_REF}/reset-operations/${OPERATION_ID}`,
    undefined,
    {
      getOperation(input) {
        assert.deepEqual(input, { accountRef: ACCOUNT_REF, operationId: OPERATION_ID });
        return { operationId: OPERATION_ID, status: 'unknown' };
      }
    }
  );
  assert.equal(await handleWebUiCodexResetCreditRoutes(queried.context), true);
  assert.equal(queried.writes[0].statusCode, 200);

  const reconciled = createContext(
    'POST',
    `/v0/webui/accounts/codex/${ACCOUNT_REF}/reset-operations/${OPERATION_ID}/reconcile`,
    undefined,
    {
      async reconcile(input) {
        assert.deepEqual(input, { accountRef: ACCOUNT_REF, operationId: OPERATION_ID });
        return {
          operation: { operationId: OPERATION_ID, status: 'succeeded', outcome: 'alreadyRedeemed' },
          reconciliationRequired: false
        };
      }
    }
  );
  assert.equal(await handleWebUiCodexResetCreditRoutes(reconciled.context), true);
  assert.equal(reconciled.writes[0].statusCode, 200);

  const conflicted = createContext(
    'POST',
    `/v0/webui/accounts/codex/${ACCOUNT_REF}/reset-credits/consume`,
    { operationId: OPERATION_ID, inventoryVersion: 'stale' },
    {
      async consume() {
        const error = new Error('重置卡库存已变化，请刷新后重试');
        error.code = 'codex_reset_inventory_changed';
        error.statusCode = 409;
        throw error;
      }
    }
  );
  assert.equal(await handleWebUiCodexResetCreditRoutes(conflicted.context), true);
  assert.deepEqual(conflicted.writes, [{
    statusCode: 409,
    body: {
      ok: false,
      error: 'codex_reset_inventory_changed',
      message: '重置卡库存已变化，请刷新后重试'
    }
  }]);
});
