import assert from 'node:assert/strict';
import test from 'node:test';

import type { AccountTokenUsage } from '@/types';
import type { TokenDropEvent } from './useTokenDropEvents.ts';
import {
  GARDEN_BITE_MS,
  GARDEN_CHEW_MS,
  GARDEN_EMERGE_MS,
  GARDEN_HUNT_MS,
  GARDEN_RETREAT_MS,
  GARDEN_STEM_HEIGHT,
  GARDEN_STEM_WIDTH,
  buildGardenAttackGeometry,
  buildGardenDamagePoint,
  buildGardenLayout,
  getGardenLifecycleDelayMs,
  getGardenPlantPhase,
  reconcileGardenLifecycle,
  scheduleGardenDrops
} from './upstream-quota-garden-model.ts';
import type { GardenLifecycleState } from './upstream-quota-garden-model.ts';

function makeUsage(overrides: Partial<AccountTokenUsage> = {}): AccountTokenUsage {
  return {
    day: 120,
    week: 3_400,
    month: 78_000,
    total: 910_000,
    models: [],
    ...overrides
  };
}

function makeDrop(id: string, occurredAt = 1_000): TokenDropEvent {
  return {
    id,
    provider: 'codex',
    accountRef: 'acct_api',
    deltaTokens: 512,
    deltaCostUsd: 0.002,
    occurredAt
  };
}

test('buildGardenLayout anchors at most three plants to real token bars', () => {
  const layout = buildGardenLayout('acct_api', makeUsage());

  assert.equal(layout.columns, 4);
  assert.equal(layout.profiles.length, 3);
  assert.equal(new Set(layout.profiles.map((profile) => profile.metricIndex)).size, 3);
  assert.ok(layout.profiles.every((profile) => profile.anchorXPercent > 0));
  assert.ok(layout.profiles.every((profile) => profile.anchorXPercent < 100));
  assert.ok(layout.profiles.every((profile) => profile.anchorY >= 5 && profile.anchorY <= 31));
});

test('buildGardenLayout never invents extra plant anchors when token periods collapse', () => {
  const layout = buildGardenLayout('acct_api', makeUsage({
    day: 0,
    week: 100,
    month: 100,
    total: 100
  }));

  assert.equal(layout.columns, 1);
  assert.equal(layout.profiles.length, 1);
  assert.equal(layout.profiles[0].metricKey, 'week');
});

test('garden anchors mirror the token SVG meet scaling on desktop and raw coordinates on mobile', () => {
  const layout = buildGardenLayout('acct_api', makeUsage());
  const desktopScale = (layout.columns * 46 + 2) / (layout.columns * 52);

  layout.profiles.forEach((profile) => {
    const expectedDesktopY = 19 + (profile.mobileAnchorY - 19) * desktopScale;
    assert.ok(Math.abs(profile.anchorY - expectedDesktopY) < 0.000001);
    assert.ok(profile.mobileAnchorY >= 5 && profile.mobileAnchorY <= 31);
  });
});

test('plant heads stay account-specific while every stem uses one shared shape', () => {
  const first = buildGardenLayout('acct_alpha', makeUsage());
  const repeated = buildGardenLayout('acct_alpha', makeUsage());
  const second = buildGardenLayout('acct_beta', makeUsage());

  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first.profiles, second.profiles);
  assert.equal(new Set(first.profiles.map((profile) => profile.stemHeight)).size, 1);
  assert.equal(new Set(first.profiles.map((profile) => profile.stemWidth)).size, 1);
  assert.equal(new Set(first.profiles.map((profile) => profile.stemColor)).size, 1);
  assert.ok(first.profiles.every((profile) => profile.stemHeight === GARDEN_STEM_HEIGHT));
  assert.ok(first.profiles.every((profile) => profile.stemWidth === GARDEN_STEM_WIDTH));
  assert.equal(GARDEN_STEM_WIDTH, 3);
  assert.equal(new Set(first.profiles.map((profile) => profile.headHueRotateDeg)).size, 1);
});

test('damage point is deterministic and remains inside the remaining quota source', () => {
  const source = { left: 100, top: 40, width: 240, height: 84 };
  const first = buildGardenDamagePoint('acct_api', 'damage-a', source);
  const repeated = buildGardenDamagePoint('acct_api', 'damage-a', source);
  const second = buildGardenDamagePoint('acct_api', 'damage-b', source);

  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first, second);
  assert.ok(first.x > source.left && first.x < source.left + source.width);
  assert.ok(first.y > source.top && first.y < source.top + source.height);
});

test('attack geometry forms an elevated cubic arc before diving into quota damage', () => {
  const origin = { x: 420, y: 100 };
  const target = { x: 220, y: 100 };
  const geometry = buildGardenAttackGeometry(
    origin,
    target
  );
  const cubicMidpointY = (
    origin.y
    + 3 * geometry.control1.y
    + 3 * geometry.control2.y
    + target.y
  ) / 8;
  const straightMidpointY = (origin.y + target.y) / 2;

  assert.deepEqual(geometry.origin, origin);
  assert.deepEqual(geometry.target, target);
  assert.ok(geometry.control1.y < Math.min(origin.y, target.y));
  assert.ok(geometry.control2.y < Math.min(origin.y, target.y));
  assert.ok(cubicMidpointY < straightMidpointY - 30);
  assert.match(geometry.pathData, /^M 420 100 C /);
  assert.ok(geometry.pathData.endsWith('220 100'));
});

test('attack geometry adds a lateral bow when mobile anchors are vertically aligned', () => {
  const origin = { x: 200, y: 220 };
  const target = { x: 200, y: 100 };
  const geometry = buildGardenAttackGeometry(origin, target);

  assert.notEqual(geometry.control1.x, origin.x);
  assert.notEqual(geometry.control2.x, target.x);
  assert.ok(geometry.control1.y < target.y);
  assert.ok(geometry.control2.y < target.y);
});

test('attack vine is one continuous path from the token bar root through the resting head', () => {
  const root = { x: 420, y: 128 };
  const origin = { x: 416, y: 100 };
  const target = { x: 220, y: 84 };
  const geometry = buildGardenAttackGeometry(origin, target, root);

  assert.deepEqual(geometry.root, root);
  assert.match(geometry.vinePathData, /^M 420 128 C /);
  assert.equal((geometry.vinePathData.match(/M /g) || []).length, 1);
  assert.equal((geometry.vinePathData.match(/C /g) || []).length, 2);
  assert.ok(geometry.vinePathData.includes('416 100 C'));
  assert.ok(geometry.ropeRestPercent > 0);
  assert.ok(geometry.ropeRestPercent < geometry.ropeMidPercent);
  assert.ok(geometry.ropeMidPercent < geometry.ropeNearPercent);
  assert.ok(geometry.ropeNearPercent < 100);
});

test('three plants can catch at most three simultaneous drops without queuing the fourth', () => {
  const profiles = buildGardenLayout('acct_api', makeUsage()).profiles;
  const drops = ['a', 'b', 'c', 'd'].map((id) => makeDrop(id));
  const result = scheduleGardenDrops({
    accountRef: 'acct_api',
    drops,
    profiles,
    now: 2_000,
    catchChance: 1
  });
  const caught = result.scheduled.filter((job) => job.outcome === 'caught');
  const missed = result.scheduled.filter((job) => job.outcome === 'missed');

  assert.equal(caught.length, 3);
  assert.equal(missed.length, 1);
  assert.equal(missed[0].reason, 'capacity_miss');
  assert.equal(new Set(caught.map((job) => job.plantIndex)).size, 3);
});

test('busy plants are unavailable to later damage instead of building a hidden queue', () => {
  const profiles = buildGardenLayout('acct_api', makeUsage()).profiles;
  const first = scheduleGardenDrops({
    accountRef: 'acct_api',
    drops: [makeDrop('first')],
    profiles,
    now: 2_000,
    catchChance: 1
  });
  const second = scheduleGardenDrops({
    accountRef: 'acct_api',
    drops: [makeDrop('next-1'), makeDrop('next-2'), makeDrop('next-3')],
    profiles,
    jobs: first.jobs,
    now: 2_100,
    catchChance: 1
  });

  assert.equal(second.scheduled.filter((job) => job.outcome === 'caught').length, 2);
  assert.equal(second.scheduled.filter((job) => job.reason === 'capacity_miss').length, 1);
});

test('catch chance can miss even when a plant is idle', () => {
  const profiles = buildGardenLayout('acct_api', makeUsage()).profiles;
  const result = scheduleGardenDrops({
    accountRef: 'acct_api',
    drops: [makeDrop('miss-1'), makeDrop('miss-2')],
    profiles,
    now: 2_000,
    catchChance: 0
  });

  assert.ok(result.scheduled.every((job) => job.outcome === 'missed'));
  assert.ok(result.scheduled.every((job) => job.reason === 'chance_miss'));
});

test('garden scheduler is deterministic for the same account, drops and clock', () => {
  const profiles = buildGardenLayout('acct_api', makeUsage()).profiles;
  const input = {
    accountRef: 'acct_api',
    drops: [makeDrop('stable-a'), makeDrop('stable-b')],
    profiles,
    now: 2_000
  };

  assert.deepEqual(scheduleGardenDrops(input), scheduleGardenDrops(input));
});

test('garden lifecycle finishes work before retreating and hides only after the pipe descent', () => {
  let state: GardenLifecycleState = { phase: 'hidden', startedAt: 1_000 };

  state = reconcileGardenLifecycle(state, {
    requestedActive: true,
    hasPendingJobs: false,
    now: 1_100
  });
  assert.deepEqual(state, { phase: 'emerging', startedAt: 1_100 });
  assert.equal(getGardenLifecycleDelayMs(state, 1_100), GARDEN_EMERGE_MS);

  state = reconcileGardenLifecycle(state, {
    requestedActive: false,
    hasPendingJobs: true,
    now: 1_100 + GARDEN_EMERGE_MS
  });
  assert.equal(state.phase, 'visible');

  state = reconcileGardenLifecycle(state, {
    requestedActive: false,
    hasPendingJobs: true,
    now: 2_000
  });
  assert.equal(state.phase, 'visible');

  state = reconcileGardenLifecycle(state, {
    requestedActive: false,
    hasPendingJobs: false,
    now: 2_100
  });
  assert.deepEqual(state, { phase: 'retreating', startedAt: 2_100 });
  assert.equal(getGardenLifecycleDelayMs(state, 2_100), GARDEN_RETREAT_MS);

  state = reconcileGardenLifecycle(state, {
    requestedActive: false,
    hasPendingJobs: false,
    now: 2_100 + GARDEN_RETREAT_MS - 1
  });
  assert.equal(state.phase, 'retreating');

  state = reconcileGardenLifecycle(state, {
    requestedActive: false,
    hasPendingJobs: false,
    now: 2_100 + GARDEN_RETREAT_MS
  });
  assert.equal(state.phase, 'hidden');
});

test('garden lifecycle reverses a retreat into a fresh emergence when work resumes', () => {
  const state = reconcileGardenLifecycle(
    { phase: 'retreating', startedAt: 3_000 },
    { requestedActive: true, hasPendingJobs: false, now: 3_180 }
  );

  assert.deepEqual(state, { phase: 'emerging', startedAt: 3_180 });
});

test('plant state machine exposes emergence, hunt, bite, chewing, recovery and idle phases', () => {
  const profiles = buildGardenLayout('acct_api', makeUsage()).profiles;
  const job = scheduleGardenDrops({
    accountRef: 'acct_api',
    drops: [makeDrop('phase')],
    profiles,
    now: 2_000,
    catchChance: 1,
    minimumDelayMs: 0
  }).scheduled[0];

  assert.equal(getGardenPlantPhase({
    lifecycle: 'hidden',
    now: 2_100,
    job
  }), 'dormant');
  assert.equal(getGardenPlantPhase({
    lifecycle: 'emerging',
    now: 2_000 + GARDEN_EMERGE_MS - 1
  }), 'emerging');
  assert.equal(getGardenPlantPhase({
    lifecycle: 'retreating',
    now: 2_000
  }), 'retreating');
  assert.equal(getGardenPlantPhase({
    lifecycle: 'visible',
    now: job.attackAt + 1,
    job
  }), 'hunting');
  assert.equal(getGardenPlantPhase({
    lifecycle: 'visible',
    now: job.attackAt + GARDEN_HUNT_MS + 1,
    job
  }), 'bite');
  assert.equal(getGardenPlantPhase({
    lifecycle: 'visible',
    now: job.attackAt + GARDEN_HUNT_MS + GARDEN_BITE_MS + 1,
    job
  }), 'chewing');
  assert.equal(getGardenPlantPhase({
    lifecycle: 'visible',
    now: job.attackAt + GARDEN_HUNT_MS + GARDEN_BITE_MS + GARDEN_CHEW_MS + 1,
    job
  }), 'recover');
  assert.equal(getGardenPlantPhase({
    lifecycle: 'visible',
    now: job.endsAt + 1,
    job
  }), 'swaying');
});
