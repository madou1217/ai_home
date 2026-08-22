'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { registerAccountIdentity } = require('../lib/account/account-registration');

let subject = {};
try {
  subject = require('../lib/server/codex-reset-credit-store');
} catch (_error) {}

const {
  completeResetCreditOperation,
  getResetCreditOperation,
  listResetCreditHistory,
  markResetCreditOperationUnknown,
  reserveResetCreditOperation,
  syncResetCreditInventory
} = subject;

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-reset-store-'));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'oauth:codex:reset-store@example.com'
  });
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return { aiHomeDir, accountRef: registration.accountRef };
}

function inventory(credits, availableCount = credits.length, detailsComplete = true) {
  return { credits, availableCount, detailsComplete };
}

test('persists reset-card acquisition, expiry, last-seen, missing, and consumption times', (t) => {
  assert.equal(typeof syncResetCreditInventory, 'function');
  assert.equal(typeof listResetCreditHistory, 'function');
  const fixture = createFixture(t);

  syncResetCreditInventory(fs, fixture.aiHomeDir, fixture.accountRef, inventory([
    { creditId: 'credit-a', status: 'available', grantedAt: 500, expiresAt: 5_000 },
    { creditId: 'credit-expired', status: 'available', grantedAt: 400, expiresAt: 900 }
  ]), { now: 1_000 });

  assert.deepEqual(
    listResetCreditHistory(fs, fixture.aiHomeDir, fixture.accountRef, { now: 1_000 }),
    [
      {
        accountRef: fixture.accountRef,
        creditId: 'credit-expired',
        status: 'expired',
        grantedAt: 400,
        expiresAt: 900,
        firstSeenAt: 1_000,
        lastSeenAt: 1_000,
        consumedAt: null,
        consumedOperationId: '',
        statusSource: 'derived'
      },
      {
        accountRef: fixture.accountRef,
        creditId: 'credit-a',
        status: 'available',
        grantedAt: 500,
        expiresAt: 5_000,
        firstSeenAt: 1_000,
        lastSeenAt: 1_000,
        consumedAt: null,
        consumedOperationId: '',
        statusSource: 'upstream'
      }
    ]
  );

  syncResetCreditInventory(
    fs,
    fixture.aiHomeDir,
    fixture.accountRef,
    inventory([], 0, true),
    { now: 2_000 }
  );

  const missing = listResetCreditHistory(fs, fixture.aiHomeDir, fixture.accountRef, { now: 2_000 })
    .find((credit) => credit.creditId === 'credit-a');
  assert.equal(missing.status, 'missing');
  assert.equal(missing.firstSeenAt, 1_000);
  assert.equal(missing.lastSeenAt, 1_000);
});

test('reserves one account operation, deduplicates its operation id, and blocks other clicks', (t) => {
  assert.equal(typeof reserveResetCreditOperation, 'function');
  assert.equal(typeof markResetCreditOperationUnknown, 'function');
  assert.equal(typeof completeResetCreditOperation, 'function');
  assert.equal(typeof getResetCreditOperation, 'function');
  const fixture = createFixture(t);
  syncResetCreditInventory(fs, fixture.aiHomeDir, fixture.accountRef, inventory([
    { creditId: 'credit-a', status: 'available', grantedAt: 100, expiresAt: 1_000 },
    { creditId: 'credit-b', status: 'available', grantedAt: 200, expiresAt: 2_000 }
  ]), { now: 300 });

  const first = reserveResetCreditOperation(fs, fixture.aiHomeDir, {
    operationId: '11111111-1111-4111-8111-111111111111',
    accountRef: fixture.accountRef,
    creditId: 'credit-a',
    inventoryVersion: 'version-1',
    beforeCount: 2,
    now: 400
  });
  const duplicate = reserveResetCreditOperation(fs, fixture.aiHomeDir, {
    operationId: '11111111-1111-4111-8111-111111111111',
    accountRef: fixture.accountRef,
    creditId: 'credit-a',
    inventoryVersion: 'version-1',
    beforeCount: 2,
    now: 401
  });

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.operation.status, 'consuming');
  assert.throws(() => reserveResetCreditOperation(fs, fixture.aiHomeDir, {
    operationId: '22222222-2222-4222-8222-222222222222',
    accountRef: fixture.accountRef,
    creditId: 'credit-b',
    inventoryVersion: 'version-1',
    beforeCount: 2,
    now: 402
  }), (error) => (
    error.code === 'codex_reset_operation_in_progress'
    && error.statusCode === 409
  ));

  markResetCreditOperationUnknown(fs, fixture.aiHomeDir, {
    operationId: first.operation.operationId,
    errorCode: 'codex_app_server_disconnected',
    now: 500
  });
  assert.throws(() => reserveResetCreditOperation(fs, fixture.aiHomeDir, {
    operationId: '22222222-2222-4222-8222-222222222222',
    accountRef: fixture.accountRef,
    creditId: 'credit-b',
    inventoryVersion: 'version-1',
    beforeCount: 2,
    now: 501
  }), (error) => (
    error.code === 'codex_reset_operation_unknown'
    && error.statusCode === 409
  ));

  completeResetCreditOperation(fs, fixture.aiHomeDir, {
    operationId: first.operation.operationId,
    outcome: 'reset',
    afterCount: 1,
    now: 600
  });
  const completed = getResetCreditOperation(
    fs,
    fixture.aiHomeDir,
    first.operation.operationId
  );
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.outcome, 'reset');
  assert.equal(completed.completedAt, 600);

  const consumed = listResetCreditHistory(fs, fixture.aiHomeDir, fixture.accountRef, { now: 600 })
    .find((credit) => credit.creditId === 'credit-a');
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.consumedAt, 600);
  assert.equal(consumed.consumedOperationId, first.operation.operationId);

  const next = reserveResetCreditOperation(fs, fixture.aiHomeDir, {
    operationId: '22222222-2222-4222-8222-222222222222',
    accountRef: fixture.accountRef,
    creditId: 'credit-b',
    inventoryVersion: 'version-2',
    beforeCount: 1,
    now: 700
  });
  assert.equal(next.created, true);
});

test('maps idempotency conflicts to HTTP 409', (t) => {
  const fixture = createFixture(t);
  syncResetCreditInventory(fs, fixture.aiHomeDir, fixture.accountRef, inventory([
    { creditId: 'credit-a', status: 'available', grantedAt: 100, expiresAt: 1_000 }
  ]), { now: 300 });

  reserveResetCreditOperation(fs, fixture.aiHomeDir, {
    operationId: '11111111-1111-4111-8111-111111111111',
    accountRef: fixture.accountRef,
    creditId: 'credit-a',
    inventoryVersion: 'version-1',
    beforeCount: 1,
    now: 400
  });

  assert.throws(() => reserveResetCreditOperation(fs, fixture.aiHomeDir, {
    operationId: '11111111-1111-4111-8111-111111111111',
    accountRef: fixture.accountRef,
    creditId: 'credit-a',
    inventoryVersion: 'version-2',
    beforeCount: 1,
    now: 401
  }), (error) => (
    error.code === 'codex_reset_idempotency_conflict'
    && error.statusCode === 409
  ));
});
