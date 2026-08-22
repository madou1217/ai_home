'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let subject = {};
try {
  subject = require('../lib/server/codex-reset-credit-model');
} catch (_error) {}

const {
  buildResetCreditInventoryVersion,
  normalizeResetCreditInventory,
  selectNextResetCredit
} = subject;

test('normalizes Codex reset-credit inventory and preserves lifecycle timestamps', () => {
  assert.equal(typeof normalizeResetCreditInventory, 'function');

  const inventory = normalizeResetCreditInventory({
    availableCount: 3,
    credits: [
      {
        id: 'credit-later',
        resetType: 'codexRateLimits',
        status: 'available',
        grantedAt: 1_725_000_000,
        expiresAt: 1_726_000_000
      },
      {
        id: 'credit-sooner',
        resetType: 'codexRateLimits',
        status: 'available',
        grantedAt: 1_724_000_000,
        expiresAt: 1_725_000_000
      },
      {
        id: 'other-reset-type',
        resetType: 'unknown',
        status: 'available',
        grantedAt: 1_724_000_000,
        expiresAt: 1_725_000_000
      }
    ]
  });

  assert.equal(inventory.availableCount, 3);
  assert.equal(inventory.detailsComplete, false);
  assert.deepEqual(inventory.credits.map((credit) => credit.creditId), [
    'credit-sooner',
    'credit-later'
  ]);
  assert.deepEqual(inventory.credits[0], {
    creditId: 'credit-sooner',
    status: 'available',
    grantedAt: 1_724_000_000_000,
    expiresAt: 1_725_000_000_000
  });
});

test('selects the earliest-expiring unexpired reset credit and excludes unsafe expiries', () => {
  assert.equal(typeof selectNextResetCredit, 'function');

  const selected = selectNextResetCredit([
    { creditId: 'no-expiry', status: 'available', grantedAt: 30, expiresAt: null },
    { creditId: 'already-used', status: 'consumed', grantedAt: 10, expiresAt: 50 },
    { creditId: 'expired', status: 'available', grantedAt: 5, expiresAt: 99 },
    { creditId: 'later', status: 'available', grantedAt: 20, expiresAt: 200 },
    { creditId: 'sooner', status: 'available', grantedAt: 10, expiresAt: 101 }
  ], 100);

  assert.equal(selected.creditId, 'sooner');
});

test('fails closed when an available card omits a finite expiry timestamp', async (t) => {
  const cases = [
    ['missing', {}],
    ['null', { expiresAt: null }],
    ['empty', { expiresAt: '' }]
  ];

  for (const [name, expiry] of cases) {
    await t.test(name, () => {
      const inventory = normalizeResetCreditInventory({
        availableCount: 1,
        credits: [{
          id: `unsafe-expiry-${name}`,
          resetType: 'codexRateLimits',
          status: 'available',
          ...expiry
        }]
      });

      assert.equal(inventory.detailsComplete, false);
      assert.equal(selectNextResetCredit(inventory.credits, 100), null);
    });
  }
});

test('treats a confirmed zero count as complete even when detail rows are omitted', () => {
  const inventory = normalizeResetCreditInventory({
    availableCount: 0,
    credits: null
  });

  assert.deepEqual(inventory, {
    availableCount: 0,
    detailsComplete: true,
    credits: []
  });
});

test('fails closed when available counts conflict with distinct available cards', () => {
  const mixed = normalizeResetCreditInventory({
    availableCount: 2,
    credits: [
      {
        id: 'available-credit',
        resetType: 'codexRateLimits',
        status: 'available',
        expiresAt: '2026-09-21T00:00:00Z'
      },
      {
        id: 'consumed-credit',
        resetType: 'codexRateLimits',
        status: 'redeemed',
        expiresAt: '2026-09-22T00:00:00Z'
      }
    ]
  });
  assert.equal(mixed.detailsComplete, false);

  const contradictoryZero = normalizeResetCreditInventory({
    availableCount: 0,
    credits: [{
      id: 'unexpected-available-credit',
      resetType: 'codexRateLimits',
      status: 'available',
      expiresAt: '2026-09-21T00:00:00Z'
    }]
  });
  assert.equal(contradictoryZero.detailsComplete, false);

  const duplicated = normalizeResetCreditInventory({
    availableCount: 2,
    credits: [
      {
        id: 'duplicate-credit',
        resetType: 'codexRateLimits',
        status: 'available',
        expiresAt: '2026-09-21T00:00:00Z'
      },
      {
        id: 'duplicate-credit',
        resetType: 'codexRateLimits',
        status: 'available',
        expiresAt: '2026-09-21T00:00:00Z'
      }
    ]
  });
  assert.equal(duplicated.detailsComplete, false);
  assert.deepEqual(duplicated.credits.map((credit) => credit.creditId), ['duplicate-credit']);
});

test('fails closed when an available card has a malformed expiry timestamp', () => {
  const inventory = normalizeResetCreditInventory({
    availableCount: 1,
    credits: [{
      id: 'malformed-expiry',
      resetType: 'codexRateLimits',
      status: 'available',
      expiresAt: 'not-a-date'
    }]
  });

  assert.equal(inventory.detailsComplete, false);
});

test('builds an order-independent inventory version that changes with card state', () => {
  assert.equal(typeof buildResetCreditInventoryVersion, 'function');

  const left = buildResetCreditInventoryVersion({
    availableCount: 2,
    credits: [
      { creditId: 'b', status: 'available', grantedAt: 20, expiresAt: null },
      { creditId: 'a', status: 'available', grantedAt: 10, expiresAt: 100 }
    ]
  });
  const reordered = buildResetCreditInventoryVersion({
    availableCount: 2,
    credits: [
      { creditId: 'a', status: 'available', grantedAt: 10, expiresAt: 100 },
      { creditId: 'b', status: 'available', grantedAt: 20, expiresAt: null }
    ]
  });
  const changed = buildResetCreditInventoryVersion({
    availableCount: 1,
    credits: [
      { creditId: 'a', status: 'available', grantedAt: 10, expiresAt: 100 }
    ]
  });

  assert.match(left, /^[a-f0-9]{64}$/);
  assert.equal(left, reordered);
  assert.notEqual(left, changed);
});
