import assert from 'node:assert/strict';
import test from 'node:test';

import type { Account } from '@/types';
import {
  appendLiveTokenEvent,
  appendTokenDrop,
  diffTokenUsage,
  MAX_LIVE_TOKEN_EVENTS,
  mergeLiveTokenDrops,
  type TokenDropEvent
} from './useTokenDropEvents.ts';

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
  const drops = Array.from({ length: 32 }, (_, index) => makeDrop(`drop-${index}`));
  const next = appendTokenDrop(drops, makeDrop('drop-new'));

  assert.equal(next.length, 32);
  assert.equal(next.at(-1)?.id, 'drop-new');
  assert.equal(next.some((drop) => drop.id === 'drop-0'), false);
});

test('appendTokenDrop keeps at most six active drops for one account', () => {
  const drops = [
    makeDrop('drop-a-1', 'acct-a'),
    makeDrop('drop-a-2', 'acct-a'),
    makeDrop('drop-a-3', 'acct-a'),
    makeDrop('drop-a-4', 'acct-a'),
    makeDrop('drop-a-5', 'acct-a'),
    makeDrop('drop-a-6', 'acct-a'),
    makeDrop('drop-b-1', 'acct-b')
  ];
  const next = appendTokenDrop(drops, makeDrop('drop-a-7', 'acct-a'));

  assert.equal(next.filter((drop) => drop.accountRef === 'acct-a').length, 6);
  assert.equal(next.some((drop) => drop.id === 'drop-a-1'), false);
  assert.equal(next.some((drop) => drop.id === 'drop-a-2'), true);
  assert.equal(next.some((drop) => drop.id === 'drop-a-7'), true);
  assert.equal(next.at(-1)?.id, 'drop-a-7');
  assert.equal(next.some((drop) => drop.id === 'drop-b-1'), true);
});

test('appendLiveTokenEvent bounds and de-duplicates the raw SSE event queue', () => {
  let events: TokenDropEvent[] = [];
  for (let index = 0; index < MAX_LIVE_TOKEN_EVENTS + 4; index += 1) {
    events = appendLiveTokenEvent(events, makeDrop(`live-${index}`));
  }

  assert.equal(events.length, MAX_LIVE_TOKEN_EVENTS);
  assert.equal(events[0].id, 'live-4');
  assert.equal(events.at(-1)?.id, `live-${MAX_LIVE_TOKEN_EVENTS + 3}`);

  events = appendLiveTokenEvent(events, makeDrop('live-12'));
  assert.equal(events.filter((event) => event.id === 'live-12').length, 1);
  assert.equal(events.at(-1)?.id, 'live-12');
});

test('mergeLiveTokenDrops appends unseen live events and records their ids', () => {
  const drops = [makeDrop('diff-1')];
  const liveEvents = [makeDrop('live-1'), makeDrop('live-2')];

  const { drops: merged, seenIds } = mergeLiveTokenDrops(drops, liveEvents, new Set());

  assert.equal(merged.length, 3);
  assert.equal(merged.at(-1)?.id, 'live-2');
  assert.equal(seenIds.has('live-1'), true);
  assert.equal(seenIds.has('live-2'), true);
});

test('mergeLiveTokenDrops is idempotent for already-seen live events', () => {
  const drops = [makeDrop('diff-1')];
  const liveEvents = [makeDrop('live-1'), makeDrop('live-2')];
  const first = mergeLiveTokenDrops(drops, liveEvents, new Set());

  const { drops: merged, seenIds } = mergeLiveTokenDrops(first.drops, liveEvents, first.seenIds);

  assert.equal(merged.length, 3);
  assert.equal(merged.filter((drop) => drop.id === 'live-1').length, 1);
  assert.equal(seenIds.has('live-1'), true);
  assert.equal(seenIds.has('live-2'), true);
});

test('mergeLiveTokenDrops prunes seen ids that fell out of the bounded live queue', () => {
  const seen = new Set(['live-old', 'live-current']);
  const liveEvents = [makeDrop('live-current')];

  const { seenIds } = mergeLiveTokenDrops([], liveEvents, seen);

  assert.deepEqual(Array.from(seenIds), ['live-current']);
});

test('mergeLiveTokenDrops skips events without id and tolerates non-array input', () => {
  const drops = [makeDrop('diff-1')];

  const { drops: merged, seenIds } = mergeLiveTokenDrops(drops, null as unknown as TokenDropEvent[], new Set());

  assert.equal(merged.length, 1);
  assert.equal(seenIds.size, 0);

  const withEmptyId = mergeLiveTokenDrops(drops, [makeDrop('')], new Set());
  assert.equal(withEmptyId.drops.length, 1);
  assert.equal(withEmptyId.seenIds.size, 0);
});
