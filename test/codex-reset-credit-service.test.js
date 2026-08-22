'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');
const { reserveResetCreditOperation } = require('../lib/server/codex-reset-credit-store');

let subject = {};
try {
  subject = require('../lib/server/codex-reset-credit-service');
} catch (_error) {}

const { createCodexResetCreditService } = subject;

const OPERATION_A = '11111111-1111-4111-8111-111111111111';
const OPERATION_B = '22222222-2222-4222-8222-222222222222';

function snapshot(credits, availableCount = credits.length) {
  return {
    rateLimitResetCredits: {
      availableCount,
      credits
    }
  };
}

function credit(id, grantedAt, expiresAt) {
  return {
    id,
    resetType: 'codexRateLimits',
    status: 'available',
    grantedAt,
    expiresAt
  };
}

function createFixture(t, overrides = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-reset-service-'));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'oauth:codex:reset-service@example.com'
  });
  const state = {
    rateLimits: snapshot([
      credit('credit-sooner', 100, 1_000),
      credit('credit-later', 200, 2_000)
    ]),
    consumeCalls: []
  };
  const service = createCodexResetCreditService({
    fs,
    aiHomeDir,
    now: () => typeof overrides.now === 'function' ? overrides.now() : (overrides.now ?? 500),
    consumeTimeoutMs: overrides.consumeTimeoutMs,
    assertOAuthAccount: () => true,
    readRateLimits: async () => state.rateLimits,
    consumeCredit: async (accountRef, params) => {
      state.consumeCalls.push({ accountRef, ...params });
      if (overrides.consumeCredit) return overrides.consumeCredit(accountRef, params, state);
      return { outcome: 'reset' };
    }
  });
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return { aiHomeDir, accountRef: registration.accountRef, service, state };
}

test('rejects a stale inventory version before any reset card is consumed', async (t) => {
  assert.equal(typeof createCodexResetCreditService, 'function');
  const fixture = createFixture(t);
  const listed = await fixture.service.list(fixture.accountRef);

  fixture.state.rateLimits = snapshot([
    credit('credit-later', 200, 2_000)
  ]);

  await assert.rejects(
    fixture.service.consume({
      accountRef: fixture.accountRef,
      operationId: OPERATION_A,
      inventoryVersion: listed.inventoryVersion
    }),
    (error) => error.code === 'codex_reset_inventory_changed'
  );
  assert.equal(fixture.state.consumeCalls.length, 0);
});

test('default account gate rejects Codex API-key accounts before reading inventory', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-reset-api-key-'));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'api-key:codex:reset-service'
  });
  writeAccountCredentials(fs, aiHomeDir, registration.accountRef, {
    OPENAI_API_KEY: 'test-only-api-key'
  });
  let reads = 0;
  const service = createCodexResetCreditService({
    fs,
    aiHomeDir,
    getProfileDir: () => path.join(aiHomeDir, 'profiles', registration.accountRef),
    readRateLimits: async () => {
      reads += 1;
      return snapshot([]);
    },
    consumeCredit: async () => ({ outcome: 'reset' })
  });
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  await assert.rejects(
    service.list(registration.accountRef),
    (error) => error.code === 'codex_reset_oauth_required' && error.statusCode === 400
  );
  assert.equal(reads, 0);
});

test('turns a hung consume request into an unknown locked operation', async (t) => {
  const fixture = createFixture(t, {
    consumeTimeoutMs: 5,
    consumeCredit: async () => new Promise(() => {})
  });
  const listed = await fixture.service.list(fixture.accountRef);
  const result = await Promise.race([
    fixture.service.consume({
      accountRef: fixture.accountRef,
      operationId: OPERATION_A,
      inventoryVersion: listed.inventoryVersion
    }),
    new Promise((resolve) => setTimeout(() => resolve('test-timeout'), 50))
  ]);

  assert.notEqual(result, 'test-timeout');
  assert.equal(result.operation.status, 'unknown');
  assert.equal(result.operation.errorCode, 'codex_reset_consume_timeout');
});

test('coalesces the same operation id and immediately rejects a different concurrent click', async (t) => {
  let releaseConsume;
  let consumeStarted;
  const started = new Promise((resolve) => { consumeStarted = resolve; });
  const gate = new Promise((resolve) => { releaseConsume = resolve; });
  const fixture = createFixture(t, {
    consumeCredit: async () => {
      consumeStarted();
      await gate;
      return { outcome: 'reset' };
    }
  });
  const listed = await fixture.service.list(fixture.accountRef);
  const first = fixture.service.consume({
    accountRef: fixture.accountRef,
    operationId: OPERATION_A,
    inventoryVersion: listed.inventoryVersion
  });
  await started;

  const duplicate = fixture.service.consume({
    accountRef: fixture.accountRef,
    operationId: OPERATION_A,
    inventoryVersion: listed.inventoryVersion
  });
  await assert.rejects(
    fixture.service.consume({
      accountRef: fixture.accountRef,
      operationId: OPERATION_B,
      inventoryVersion: listed.inventoryVersion
    }),
    (error) => error.code === 'codex_reset_operation_in_progress'
  );

  releaseConsume();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
  assert.equal(fixture.state.consumeCalls.length, 1);
  assert.deepEqual(fixture.state.consumeCalls[0], {
    accountRef: fixture.accountRef,
    idempotencyKey: OPERATION_A,
    creditId: 'credit-sooner'
  });
  assert.equal(firstResult.operation.status, 'succeeded');
  assert.deepEqual(duplicateResult, firstResult);

  const retry = await fixture.service.consume({
    accountRef: fixture.accountRef,
    operationId: OPERATION_A,
    inventoryVersion: listed.inventoryVersion
  });
  assert.equal(retry.operation.status, 'succeeded');
  assert.equal(fixture.state.consumeCalls.length, 1);
});

test('rejects an operation id reused with a different inventory version', async (t) => {
  let releaseConsume;
  let consumeStarted;
  const started = new Promise((resolve) => { consumeStarted = resolve; });
  const gate = new Promise((resolve) => { releaseConsume = resolve; });
  const fixture = createFixture(t, {
    consumeCredit: async () => {
      consumeStarted();
      await gate;
      return { outcome: 'reset' };
    }
  });
  const listed = await fixture.service.list(fixture.accountRef);
  const first = fixture.service.consume({
    accountRef: fixture.accountRef,
    operationId: OPERATION_A,
    inventoryVersion: listed.inventoryVersion
  });
  await started;

  const conflicting = fixture.service.consume({
    accountRef: fixture.accountRef,
    operationId: OPERATION_A,
    inventoryVersion: 'different-inventory-version'
  }).then(
    () => null,
    (error) => error
  );
  const observed = await Promise.race([
    conflicting,
    new Promise((resolve) => setTimeout(() => resolve('test-timeout'), 25))
  ]);

  releaseConsume();
  await first;
  assert.notEqual(observed, 'test-timeout');
  assert.equal(observed && observed.code, 'codex_reset_idempotency_conflict');

  await assert.rejects(
    fixture.service.consume({
      accountRef: fixture.accountRef,
      operationId: OPERATION_A,
      inventoryVersion: 'different-inventory-version'
    }),
    (error) => error.code === 'codex_reset_idempotency_conflict'
  );
  assert.equal(fixture.state.consumeCalls.length, 1);
});

test('treats capped detail rows as non-selectable instead of guessing which card expires first', async (t) => {
  const fixture = createFixture(t);
  fixture.state.rateLimits = snapshot([
    credit('credit-known', 100, 1_000)
  ], 2);

  const listed = await fixture.service.list(fixture.accountRef);

  assert.equal(listed.availableCount, 2);
  assert.equal(listed.detailsComplete, false);
  assert.equal(listed.selectableCount, 0);
  assert.equal(listed.nextCreditId, '');
  await assert.rejects(
    fixture.service.consume({
      accountRef: fixture.accountRef,
      operationId: OPERATION_A,
      inventoryVersion: listed.inventoryVersion
    }),
    (error) => error.code === 'codex_reset_credit_details_incomplete'
  );
  assert.equal(fixture.state.consumeCalls.length, 0);
});

test('treats an available card without expiry as non-selectable', async (t) => {
  const fixture = createFixture(t);
  fixture.state.rateLimits = snapshot([{
    id: 'credit-without-expiry',
    resetType: 'codexRateLimits',
    status: 'available',
    grantedAt: 100
  }]);

  const listed = await fixture.service.list(fixture.accountRef);

  assert.equal(listed.availableCount, 1);
  assert.equal(listed.detailsComplete, false);
  assert.equal(listed.selectableCount, 0);
  assert.equal(listed.nextCreditId, '');
  await assert.rejects(
    fixture.service.consume({
      accountRef: fixture.accountRef,
      operationId: OPERATION_A,
      inventoryVersion: listed.inventoryVersion
    }),
    (error) => error.code === 'codex_reset_credit_details_incomplete'
  );
  assert.equal(fixture.state.consumeCalls.length, 0);
});

test('fails closed when an upstream-available card is already expired locally', async (t) => {
  const currentTime = Date.parse('2026-08-22T00:00:00Z');
  const fixture = createFixture(t, { now: currentTime });
  fixture.state.rateLimits = snapshot([
    credit(
      'credit-expired',
      Math.trunc((currentTime - 60_000) / 1000),
      Math.trunc((currentTime - 1_000) / 1000)
    ),
    credit(
      'credit-valid',
      Math.trunc((currentTime - 30_000) / 1000),
      Math.trunc((currentTime + 60_000) / 1000)
    )
  ], 2);

  const listed = await fixture.service.list(fixture.accountRef);

  assert.equal(listed.availableCount, 2);
  assert.equal(listed.detailsComplete, false);
  assert.equal(listed.selectableCount, 0);
  assert.equal(listed.nextCreditId, '');
  await assert.rejects(
    fixture.service.consume({
      accountRef: fixture.accountRef,
      operationId: OPERATION_A,
      inventoryVersion: listed.inventoryVersion
    }),
    (error) => error.code === 'codex_reset_credit_details_incomplete'
  );
  assert.equal(fixture.state.consumeCalls.length, 0);
});

test('recovers an interrupted persisted consume as unknown after the timeout window', async (t) => {
  let currentTime = 500;
  const fixture = createFixture(t, { now: () => currentTime, consumeTimeoutMs: 30_000 });
  const listed = await fixture.service.list(fixture.accountRef);
  reserveResetCreditOperation(fs, fixture.aiHomeDir, {
    operationId: OPERATION_A,
    accountRef: fixture.accountRef,
    creditId: 'credit-sooner',
    inventoryVersion: listed.inventoryVersion,
    beforeCount: 2,
    now: currentTime
  });

  currentTime += 30_001;
  const recovered = await fixture.service.list(fixture.accountRef);

  assert.equal(recovered.activeOperation.operationId, OPERATION_A);
  assert.equal(recovered.activeOperation.status, 'unknown');
  assert.equal(recovered.activeOperation.errorCode, 'codex_reset_server_interrupted');
  await assert.rejects(
    fixture.service.consume({
      accountRef: fixture.accountRef,
      operationId: OPERATION_B,
      inventoryVersion: recovered.inventoryVersion
    }),
    (error) => error.code === 'codex_reset_operation_unknown'
  );
});

test('keeps an unknown result locked and reconciles only with the same card and operation id', async (t) => {
  let failConsume = true;
  const fixture = createFixture(t, {
    consumeCredit: async () => {
      if (failConsume) throw Object.assign(new Error('socket closed'), {
        code: 'codex_app_server_disconnected'
      });
      return { outcome: 'alreadyRedeemed' };
    }
  });
  const listed = await fixture.service.list(fixture.accountRef);
  const uncertain = await fixture.service.consume({
    accountRef: fixture.accountRef,
    operationId: OPERATION_A,
    inventoryVersion: listed.inventoryVersion
  });

  assert.equal(uncertain.operation.status, 'unknown');
  assert.equal(uncertain.reconciliationRequired, true);
  const refreshed = await fixture.service.list(fixture.accountRef);
  assert.equal(refreshed.activeOperation.operationId, OPERATION_A);
  assert.equal(refreshed.activeOperation.status, 'unknown');
  await assert.rejects(
    fixture.service.consume({
      accountRef: fixture.accountRef,
      operationId: OPERATION_B,
      inventoryVersion: listed.inventoryVersion
    }),
    (error) => error.code === 'codex_reset_operation_unknown'
  );

  failConsume = false;
  const reconciled = await fixture.service.reconcile({
    accountRef: fixture.accountRef,
    operationId: OPERATION_A
  });

  assert.equal(fixture.state.consumeCalls.length, 2);
  assert.deepEqual(fixture.state.consumeCalls[1], {
    accountRef: fixture.accountRef,
    idempotencyKey: OPERATION_A,
    creditId: 'credit-sooner'
  });
  assert.equal(reconciled.operation.status, 'succeeded');
  assert.equal(reconciled.operation.outcome, 'alreadyRedeemed');
});

test('keeps reconciliation locked when noCredit cannot prove whether the first attempt consumed', async (t) => {
  let attempt = 0;
  const fixture = createFixture(t, {
    consumeCredit: async () => {
      attempt += 1;
      if (attempt === 1) {
        throw Object.assign(new Error('socket closed'), {
          code: 'codex_app_server_disconnected'
        });
      }
      return { outcome: 'noCredit' };
    }
  });
  const listed = await fixture.service.list(fixture.accountRef);
  const uncertain = await fixture.service.consume({
    accountRef: fixture.accountRef,
    operationId: OPERATION_A,
    inventoryVersion: listed.inventoryVersion
  });

  assert.equal(uncertain.operation.status, 'unknown');
  const reconciled = await fixture.service.reconcile({
    accountRef: fixture.accountRef,
    operationId: OPERATION_A
  });

  assert.equal(reconciled.operation.status, 'unknown');
  assert.equal(reconciled.operation.errorCode, 'codex_reset_reconcile_no_credit');
  assert.equal(reconciled.reconciliationRequired, true);
});
