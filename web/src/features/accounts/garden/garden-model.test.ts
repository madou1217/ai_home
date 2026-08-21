import assert from 'node:assert/strict';
import test from 'node:test';

import type { AccountTokenUsage } from '@/types';
import { buildGardenPerches, resolvePerchIndex } from './perch-model.ts';
import {
  GARDEN_HOP_FLIGHT_MS,
  GARDEN_HOP_MAX_IDLE_MS,
  createHopState,
  getHopDelayMs,
  pickHopTarget,
  reconcileHopState,
  resolveFacing
} from './hop-model.ts';
import {
  GARDEN_ATTACK_MS,
  GARDEN_CATCH_CHANCE_MAX,
  GARDEN_CATCH_CHANCE_MIN,
  getActiveCatch,
  getCatchChance,
  getGardenFeedPhase,
  scheduleGardenFeeds
} from './feeding-model.ts';
import { buildTaperedRibbonPath } from './vine-geometry.ts';
import { buildGardenAttackGeometry } from './attack-geometry.ts';
import {
  GARDEN_STALK_SEGMENTS,
  GARDEN_STEM_MAX_HEIGHT,
  GARDEN_STEM_MIN_HEIGHT,
  getHeadCenterOffset,
  getStalkSegments,
  getStemHeight
} from './plant-profile.ts';

const ACCOUNT = 'acct_0123456789abcdef0123';

function usage(values: Partial<AccountTokenUsage>): AccountTokenUsage {
  return { day: 0, week: 0, month: 0, total: 0, models: [], ...values } as AccountTokenUsage;
}

function drop(id: string, occurredAt: number) {
  return {
    id,
    provider: 'claude',
    accountRef: ACCOUNT,
    deltaTokens: 1200,
    deltaCostUsd: 0.01,
    occurredAt
  };
}

test('perch model: offers one perch per bar that is actually drawn', () => {
  const layout = buildGardenPerches(usage({ day: 10, week: 40, month: 90, total: 200 }));
  assert.equal(layout.columns, 4);
  assert.deepEqual(layout.perches.map((perch) => perch.metricKey), ['day', 'week', 'month', 'total']);
});

test('perch model: never invents perches when the token windows collapse into one bar', () => {
  // 日=周=月=总：折叠后只剩一根柱子，花只能待在原地。
  const layout = buildGardenPerches(usage({ day: 500, week: 500, month: 500, total: 500 }));
  assert.equal(layout.columns, 1);
  assert.equal((layout.perches).length, 1);
});

test('perch model: re-seats by window identity when bars are renumbered', () => {
  const perches = buildGardenPerches(usage({ day: 0, week: 40, month: 90, total: 200 })).perches;
  // 今天还没跑过，日柱被藏掉，month 的序号整体前移。
  assert.equal(
    resolvePerchIndex(perches, 'month', 99),
    perches.findIndex((perch) => perch.metricKey === 'month')
  );
});

test('perch model: falls back to a valid index when the window disappeared entirely', () => {
  const perches = buildGardenPerches(usage({ day: 500, week: 500, month: 500, total: 500 })).perches;
  assert.equal(resolvePerchIndex(perches, 'week', 3), 0);
});

const perches = buildGardenPerches(usage({ day: 10, week: 40, month: 90, total: 200 })).perches;

test('hop model: hops to some other bar, never to the one it is already on', () => {
  for (let hopIndex = 1; hopIndex <= 40; hopIndex += 1) {
    const target = pickHopTarget(ACCOUNT, hopIndex, perches.length, 2);
    assert.notEqual(target, 2);
    assert.ok((target) >= (0));
    assert.ok((target) < (perches.length));
  }
});

test('hop model: picks the same target for the same hop index (no teleporting on re-render)', () => {
  assert.equal(pickHopTarget(ACCOUNT, 7, 4, 1), pickHopTarget(ACCOUNT, 7, 4, 1));
});

test('hop model: takes off after the idle window and lands after the flight', () => {
  const start = 1_000_000;
  let state = createHopState(ACCOUNT, perches, start);
  const input = { accountRef: ACCOUNT, perches, canHop: true, now: start };

  state = reconcileHopState(state, { ...input, now: start + GARDEN_HOP_MAX_IDLE_MS + 1 });
  assert.equal(state.phase, 'airborne');
  assert.notEqual(state.fromPerchIndex, state.perchIndex);

  const takeoffAt = state.startedAt;
  const midAir = reconcileHopState(state, { ...input, now: takeoffAt + GARDEN_HOP_FLIGHT_MS - 10 });
  assert.equal(midAir.phase, 'airborne');

  const landed = reconcileHopState(state, { ...input, now: takeoffAt + GARDEN_HOP_FLIGHT_MS });
  assert.equal(landed.phase, 'settled');
  assert.equal(landed.perchIndex, state.perchIndex);
  assert.equal(landed.fromPerchIndex, state.perchIndex);
});

test('hop model: stays put while it is busy eating', () => {
  const start = 1_000_000;
  const state = createHopState(ACCOUNT, perches, start);
  const busy = reconcileHopState(state, {
    accountRef: ACCOUNT,
    perches,
    canHop: false,
    now: start + GARDEN_HOP_MAX_IDLE_MS + 1
  });
  assert.equal(busy.phase, 'settled');
});

test('hop model: sways in place instead of looping a zero-distance hop on a single bar', () => {
  const single = buildGardenPerches(usage({ day: 500, week: 500, month: 500, total: 500 })).perches;
  const start = 1_000_000;
  const state = createHopState(ACCOUNT, single, start);
  const later = reconcileHopState(state, {
    accountRef: ACCOUNT,
    perches: single,
    canHop: true,
    now: start + GARDEN_HOP_MAX_IDLE_MS * 3
  });
  assert.equal(later.phase, 'settled');
  assert.equal(getHopDelayMs(later, { perchCount: 1, now: start, canHop: true }), null);
});

test('hop model: re-seats rather than floating when the bar underneath disappears', () => {
  const start = 1_000_000;
  let state = createHopState(ACCOUNT, perches, start);
  state = { ...state, perchIndex: 3, perchMetricKey: 'total' };

  // 用量变化后只剩一根柱子：脚下的 total 柱没了。
  const collapsed = buildGardenPerches(usage({ day: 500, week: 500, month: 500, total: 500 })).perches;
  const reseated = reconcileHopState(state, {
    accountRef: ACCOUNT,
    perches: collapsed,
    canHop: true,
    now: start + 10
  });

  assert.equal(reseated.phase, 'settled');
  assert.equal(reseated.perchIndex, 0);
  assert.equal(reseated.perchMetricKey, collapsed[0].metricKey);
});

test('hop model: keeps the plant seated on the same window when the bar only moves', () => {
  const start = 1_000_000;
  const state = { ...createHopState(ACCOUNT, perches, start), perchIndex: 2, perchMetricKey: 'month' };
  const shifted = buildGardenPerches(usage({ day: 0, week: 40, month: 90, total: 200 })).perches;
  const next = reconcileHopState(state, {
    accountRef: ACCOUNT,
    perches: shifted,
    canHop: true,
    now: start + 10
  });
  assert.equal(next.perchMetricKey, 'month');
  assert.equal(shifted[next.perchIndex].metricKey, 'month');
});

test('hop model: turns around instead of jumping backwards', () => {
  const perches = buildGardenPerches(usage({ day: 10, week: 40, month: 90, total: 200 })).perches;
  // 往右跳必须转身；往左跳再转回来；朝向在同一次跳跃里不会来回抖。
  assert.equal(resolveFacing(perches, 0, 3, 1), -1);
  assert.equal(resolveFacing(perches, 3, 0, -1), 1);
  assert.equal(resolveFacing(perches, 2, 2, -1), -1);
});

test('hop model: a hop records where it was facing before taking off', () => {
  const start = 1_000_000;
  const perches = buildGardenPerches(usage({ day: 10, week: 40, month: 90, total: 200 })).perches;
  let state = createHopState(ACCOUNT, perches, start);
  state = reconcileHopState(state, {
    accountRef: ACCOUNT,
    perches,
    canHop: true,
    now: start + GARDEN_HOP_MAX_IDLE_MS + 1
  });
  assert.equal(state.phase, 'airborne');
  // 转身动画要知道两端；落地后新朝向成为下一跳的起点。
  const expected = resolveFacing(perches, state.fromPerchIndex, state.perchIndex, state.facingFrom);
  assert.equal(state.facing, expected);

  const landed = reconcileHopState(state, {
    accountRef: ACCOUNT,
    perches,
    canHop: true,
    now: state.startedAt + GARDEN_HOP_FLIGHT_MS
  });
  assert.equal(landed.facing, state.facing);
  assert.equal(landed.facingFrom, state.facing);
});

test('feeding model: catch chance stays inside the configured range', () => {
  for (let index = 0; index < 50; index += 1) {
    const chance = getCatchChance(ACCOUNT, `drop-${index}`);
    assert.ok((chance) >= (GARDEN_CATCH_CHANCE_MIN));
    assert.ok((chance) <= (GARDEN_CATCH_CHANCE_MAX));
  }
});

test('feeding model: queues the next mouthful instead of dropping it on the floor', () => {
  const now = 1_000_000;
  const { jobs } = scheduleGardenFeeds({
    accountRef: ACCOUNT,
    drops: [drop('a', now), drop('b', now + 1)],
    hasPerch: true,
    now
  });
  // 两口之内不该有人因为「花忙不过来」被丢掉——没咬中是运气问题，不是容量问题。
  assert.ok(jobs.every((job) => job.reason !== 'capacity_miss'));
  const caught = jobs.filter((job) => job.outcome === 'caught');
  caught.forEach((job, index) => {
    // 排队的那一口必须等前一口咽下去。
    if (index > 0) assert.ok((job.attackAt) >= (caught[index - 1].endsAt));
  });
});

test('feeding model: misses once the queue is full rather than eating everything at once', () => {
  const now = 1_000_000;
  const drops = Array.from({ length: 8 }, (_value, index) => drop(`burst-${index}`, now + index));
  const { jobs } = scheduleGardenFeeds({ accountRef: ACCOUNT, drops, hasPerch: true, now });
  assert.ok((jobs.filter((job) => job.reason === 'capacity_miss').length) > (0));
  // 单花一次只嚼一口：任何时刻最多一个 job 处在扑咬中。
  const active = jobs.filter((job) => job.outcome === 'caught');
  active.forEach((job, index) => {
    if (index === 0) return;
    assert.ok((job.attackAt) >= (active[index - 1].endsAt));
  });
});

test('feeding model: drops everything when there is no bar to stand on', () => {
  const now = 1_000_000;
  const { jobs } = scheduleGardenFeeds({
    accountRef: ACCOUNT,
    drops: [drop('a', now)],
    hasPerch: false,
    now
  });
  assert.equal(jobs[0].outcome, 'missed');
  assert.equal(jobs[0].reason, 'capacity_miss');
});

test('feeding model: is deterministic for the same account, drops and clock', () => {
  const now = 1_000_000;
  const input = { accountRef: ACCOUNT, drops: [drop('a', now), drop('b', now + 5)], hasPerch: true, now };
  assert.deepEqual(scheduleGardenFeeds(input).jobs, scheduleGardenFeeds(input).jobs);
});

test('feeding model: never schedules the same drop twice', () => {
  const now = 1_000_000;
  const first = scheduleGardenFeeds({
    accountRef: ACCOUNT,
    drops: [drop('a', now)],
    hasPerch: true,
    now
  });
  const second = scheduleGardenFeeds({
    accountRef: ACCOUNT,
    drops: [drop('a', now)],
    hasPerch: true,
    jobs: first.jobs,
    now: now + 10
  });
  assert.equal((second.scheduled).length, 0);
});

test('feeding model: walks through hunt, bite, chew and recover', () => {
  const now = 1_000_000;
  const { jobs } = scheduleGardenFeeds({
    accountRef: ACCOUNT,
    drops: [drop('a', now)],
    hasPerch: true,
    now,
    minimumDelayMs: 0
  });
  const job = jobs.find((entry) => entry.outcome === 'caught');
  if (!job) return;
  assert.equal(getGardenFeedPhase(job.attackAt - 1, job), 'swaying');
  assert.equal(getGardenFeedPhase(job.attackAt + 10, job), 'hunting');
  assert.equal(getGardenFeedPhase(job.attackAt + 600, job), 'bite');
  assert.equal(getGardenFeedPhase(job.attackAt + 900, job), 'chewing');
  assert.equal(getGardenFeedPhase(job.attackAt + 1300, job), 'recover');
  assert.equal(getGardenFeedPhase(job.attackAt + GARDEN_ATTACK_MS, job), 'swaying');
});

test('feeding model: reports the mouthful that is being eaten right now', () => {
  const now = 1_000_000;
  const { jobs } = scheduleGardenFeeds({
    accountRef: ACCOUNT,
    drops: [drop('a', now)],
    hasPerch: true,
    now
  });
  const job = jobs.find((entry) => entry.outcome === 'caught');
  if (!job) return;
  assert.equal(getActiveCatch(jobs, job.attackAt + 5)?.id, job.id);
  assert.equal(getActiveCatch(jobs, job.endsAt + 1), undefined);
});

test('vine geometry: the attack vine is the stem carrying on, not a second rope', () => {
  const root = { x: 100, y: 200 };
  const origin = { x: 100, y: 170 };
  const tipWidth = 4;
  const attack = buildGardenAttackGeometry(origin, { x: 320, y: 240 }, root, tipWidth);

  // 藤蔓只画伸出去的那一段：起点就是花茎顶端，根部那一段仍由原地植株自己画。
  assert.equal(attack.pathData.startsWith(`M ${origin.x} ${origin.y}`), true);
  assert.ok((attack.ropeMidPercent) > (0));
  assert.ok((attack.ropeNearPercent) > (attack.ropeMidPercent));
  assert.ok((attack.ropeNearPercent) <= (100));
});

test('vine geometry: the ribbon starts at the stem width and tapers away', () => {
  const start = { x: 0, y: 0 };
  const end = { x: 100, y: 0 };
  const startWidth = 4;
  const ribbon = buildTaperedRibbonPath(
    start,
    { x: 30, y: 0 },
    { x: 70, y: 0 },
    end,
    startWidth,
    1.8
  );
  const points = ribbon
    .replace(/[MLZ]/g, ' ')
    .trim()
    .split(/\s+/)
    .map(Number);
  // 第一个点与最后一个点是起点两侧的上下沿：它们的间距就是接住花茎的那一头。
  const firstY = points[1];
  const lastY = points[points.length - 1];
  assert.ok(Math.abs(Math.abs(firstY - lastY) - startWidth) < 0.01);
});

test('vine geometry: lifts over the card before diving onto the damage number', () => {
  // 桌面：剩余额度在右边一列，脖子要先上扬越过卡片再俯冲下去。
  const origin = { x: 100, y: 200 };
  const target = { x: 320, y: 240 };
  const attack = buildGardenAttackGeometry(origin, target, 4);
  assert.ok((attack.control1.y) < (Math.min(origin.y, target.y)));
  assert.ok((attack.control2.y) < (target.y));
});

test('vine geometry: a target straight overhead is reached by looking up, not by arcing away', () => {
  // 手机：剩余额度就在花的正上方。硬套桌面那套上扬会先冲出卡片顶部再拐回来。
  const origin = { x: 120, y: 260 };
  const target = { x: 132, y: 196 };
  const attack = buildGardenAttackGeometry(origin, target, 4);
  const apex = Math.min(attack.control1.y, attack.control2.y);
  // 弧顶最多比目标再高出一点点，不能整条脖子从卡片外面绕过去。
  assert.ok((target.y - apex) < (40));
  assert.ok((apex) < (target.y));
});

test('plant profile: the head sits on the stem tip the vine grows out of', () => {
  // 咽喉、茎顶、藤蔓起点必须是同一个点，否则脖子伸出去的地方会露接缝。
  const stemHeight = getStemHeight(20);
  assert.equal(getHeadCenterOffset(stemHeight), stemHeight);
});

test('plant profile: grows the stem with the bar it stands on, within bounds', () => {
  assert.equal(getStemHeight(0), GARDEN_STEM_MIN_HEIGHT);
  assert.ok((getStemHeight(28)) > (getStemHeight(4)));
  assert.ok((getStemHeight(1000)) <= (GARDEN_STEM_MAX_HEIGHT));
});

test('plant profile: the stalk splits into a tapering chain that spans the whole stem', () => {
  const stemHeight = getStemHeight(24);
  const segments = getStalkSegments(stemHeight);
  assert.equal(segments.length, GARDEN_STALK_SEGMENTS);
  // 骨节首尾相接，总高就是茎高——差一点点都会让头浮在茎顶上方。
  const total = segments.reduce((sum, segment) => sum + segment.height, 0);
  assert.ok(Math.abs(total - stemHeight) < 0.05);
  // 越往上越细，才像植物而不是一根等宽柱体。
  segments.forEach((segment, index) => {
    if (index > 0) assert.ok(segment.width < segments[index - 1].width);
  });
});
