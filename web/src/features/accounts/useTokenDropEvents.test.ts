import assert from 'node:assert/strict';
import test from 'node:test';

import type { Account } from '@/types';
import { appendTokenDrop, diffTokenUsage, type TokenDropEvent } from './useTokenDropEvents.ts';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    provider: 'codex',
    accountRef: 'acct_test',
    status: 'up',
    displayName: 'test',
    configured: true,
    apiKeyMode: false,
    remainingPct: null,
    updatedAt: 0,
    planType: 'free',
    email: 'user@example.com',
    ...overrides
  };
}

function makeUsage(day: number, models?: Array<{ model: string; dayCostUsd: number | null }>): Account['tokenUsage'] {
  return {
    day,
    week: day,
    month: day,
    total: day,
    models: models || []
  };
}

function makeDrop(id: string, accountRef = id): TokenDropEvent {
  return {
    id,
    provider: 'codex',
    accountRef,
    deltaTokens: 100,
    deltaCostUsd: null,
    occurredAt: 0
  };
}

test('diffTokenUsage builds baseline on first snapshot without emitting events', () => {
  const accounts = [makeAccount({ tokenUsage: makeUsage(1_200) })];
  const { deltas, next } = diffTokenUsage(accounts, new Map());

  assert.deepEqual(deltas, []);
  assert.equal(next.get('acct_test').tokens, 1_200);
});

test('diffTokenUsage emits delta when day tokens grow', () => {
  const previous = new Map([['acct_test', { tokens: 1_200, cost: null }]]);
  const accounts = [makeAccount({ tokenUsage: makeUsage(2_400) })];

  const { deltas, next } = diffTokenUsage(accounts, previous);

  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].accountRef, 'acct_test');
  assert.equal(deltas[0].provider, 'codex');
  assert.equal(deltas[0].deltaTokens, 1_200);
  assert.equal(next.get('acct_test').tokens, 2_400);
});

test('diffTokenUsage skips equal or decreased day tokens', () => {
  const previous = new Map([['acct_test', { tokens: 1_200, cost: null }]]);

  assert.deepEqual(diffTokenUsage([makeAccount({ tokenUsage: makeUsage(1_200) })], previous).deltas, []);
  assert.deepEqual(diffTokenUsage([makeAccount({ tokenUsage: makeUsage(800) })], previous).deltas, []);
});

test('diffTokenUsage computes cost delta from model dayCostUsd when both sides have data', () => {
  const previous = new Map([
    ['acct_test', { tokens: 1_000, cost: 0.05 }]
  ]);
  const accounts = [
    makeAccount({
      tokenUsage: makeUsage(1_600, [
        { model: 'gpt-5', dayCostUsd: 0.12 }
      ])
    })
  ];

  const { deltas } = diffTokenUsage(accounts, previous);

  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].deltaTokens, 600);
  assert.ok(Math.abs(deltas[0].deltaCostUsd - 0.07) < 1e-9, `cost delta ${deltas[0].deltaCostUsd} ≈ 0.07`);
});

test('diffTokenUsage leaves cost null when either side lacks cost data', () => {
  const previous = new Map([['acct_test', { tokens: 1_000, cost: null }]]);
  const accounts = [
    makeAccount({
      tokenUsage: makeUsage(1_600, [{ model: 'gpt-5', dayCostUsd: 0.12 }])
    })
  ];

  const { deltas } = diffTokenUsage(accounts, previous);
  assert.equal(deltas[0].deltaCostUsd, null);
});

test('diffTokenUsage diffs each account independently', () => {
  const previous = new Map([
    ['acct_a', { tokens: 500, cost: null }],
    ['acct_b', { tokens: 800, cost: null }]
  ]);
  const accounts = [
    makeAccount({ accountRef: 'acct_a', tokenUsage: makeUsage(900) }),
    makeAccount({ accountRef: 'acct_b', tokenUsage: makeUsage(800) })
  ];

  const { deltas } = diffTokenUsage(accounts, previous);

  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].accountRef, 'acct_a');
  assert.equal(deltas[0].deltaTokens, 400);
});

test('diffTokenUsage skips accounts without accountRef', () => {
  const accounts = [makeAccount({ accountRef: '', tokenUsage: makeUsage(100) })];
  const { deltas, next } = diffTokenUsage(accounts, new Map());

  assert.deepEqual(deltas, []);
  assert.equal(next.size, 0);
});

test('diffTokenUsage rounds delta and lifts sub-1-token deltas to 1', () => {
  const previous = new Map([['acct_test', { tokens: 100, cost: null }]]);
  const accounts = [makeAccount({ tokenUsage: makeUsage(101.6) })];

  const { deltas } = diffTokenUsage(accounts, previous);

  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].deltaTokens, 2);
});

test('diffTokenUsage lifts fractional delta below 1 to 1 token', () => {
  const previous = new Map([['acct_test', { tokens: 100, cost: null }]]);
  const accounts = [makeAccount({ tokenUsage: makeUsage(100.4) })];

  const { deltas } = diffTokenUsage(accounts, previous);

  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].deltaTokens, 1);
});

test('appendTokenDrop enforces the global queue cap', () => {
  const drops = Array.from({ length: 24 }, (_, index) => makeDrop(`drop-${index}`));
  const next = appendTokenDrop(drops, makeDrop('drop-new'));

  assert.equal(next.length, 24);
  assert.equal(next.at(-1)?.id, 'drop-new');
  assert.equal(next.some((drop) => drop.id === 'drop-0'), false);
});

test('appendTokenDrop keeps at most three active drops for one account', () => {
  const drops = [
    makeDrop('drop-a-1', 'acct-a'),
    makeDrop('drop-a-2', 'acct-a'),
    makeDrop('drop-a-3', 'acct-a'),
    makeDrop('drop-b-1', 'acct-b')
  ];
  const next = appendTokenDrop(drops, makeDrop('drop-a-4', 'acct-a'));

  assert.equal(next.filter((drop) => drop.accountRef === 'acct-a').length, 3);
  assert.equal(next.some((drop) => drop.id === 'drop-a-1'), false);
  assert.equal(next.some((drop) => drop.id === 'drop-a-2'), true);
  assert.equal(next.some((drop) => drop.id === 'drop-a-3'), true);
  assert.equal(next.at(-1)?.id, 'drop-a-4');
  assert.equal(next.some((drop) => drop.id === 'drop-b-1'), true);
});
