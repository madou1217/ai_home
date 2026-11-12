'use strict';

// 批量领取的风控节流：解算冷却 + F001 退避重试。
//
// 2026-11-05 真机实测（同一机器、同一 scene，连续解算）：
//   0s 间隔  → 3 次里 1 次 F001
//   12s 间隔 → 3 次里 1 次 F001
// F001 是概率性的风控判定，冷却消不掉它；能消掉它的是「等一会儿再解一次」。
// 所以这里守两件事：
//   1. 两次解算不并发、且开始时间至少隔 SOLVE_MIN_INTERVAL_MS；
//   2. 只有 F001 会重试，超时/本地故障不重试（重试只会白烧一次风控额度）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { __private, SOLVE_MIN_INTERVAL_MS, F001_RETRY_DELAYS_MS } = require('../lib/account/activity-claim/aliyun-captcha');
const { isF001Error, resetSolveGate, runWithF001Retry, withSolveGate } = __private;

const F001_MESSAGE = 'captcha_failed:{"ok":false,"stage":"fail","error":{"success":true,'
  + '"verifyResult":false,"verifyCode":"F001","certifyId":"JoqQFbqgYG"}}';

/** 假时钟：sleep 会推进时间并记账，便于断言「等了多少」。 */
function createClock(startAt = 1_000_000) {
  let current = startAt;
  const sleeps = [];
  return {
    sleeps,
    now: () => current,
    sleep: async (ms) => { sleeps.push(ms); current += ms; },
    advance: (ms) => { current += ms; }
  };
}

test.beforeEach(() => resetSolveGate());

test('F001 判定：只认风控拒绝，不认本地故障', () => {
  assert.equal(isF001Error(new Error(F001_MESSAGE)), true);
  assert.equal(isF001Error(new Error('captcha_failed:verifyCode F001')), true);
  assert.equal(isF001Error(new Error('captcha_timeout:60000')), false);
  assert.equal(isF001Error(new Error('captcha_devtools_timeout:ENOENT')), false);
  assert.equal(isF001Error(null), false);
});

test('两次解算之间必须等够冷却时间', async () => {
  const clock = createClock();
  const started = [];
  const options = { minIntervalMs: SOLVE_MIN_INTERVAL_MS, now: clock.now, sleep: clock.sleep };

  await withSolveGate(options, async () => { started.push('first'); });
  await withSolveGate(options, async () => { started.push('second'); });

  assert.deepEqual(started, ['first', 'second']);
  assert.deepEqual(clock.sleeps, [SOLVE_MIN_INTERVAL_MS], '第二次必须补足间隔');
});

test('上一轮解算跑了多久都不抵扣冷却：间隔从上一次结束算起', async () => {
  const clock = createClock();
  const options = { minIntervalMs: SOLVE_MIN_INTERVAL_MS, now: clock.now, sleep: clock.sleep };

  await withSolveGate(options, async () => { clock.advance(15_000); });
  await withSolveGate(options, async () => {});

  assert.deepEqual(clock.sleeps, [SOLVE_MIN_INTERVAL_MS], '解算耗时不抵扣静默间隔');
});

test('解算串行：前一个没结束，后一个不许启动', async () => {
  const clock = createClock();
  const events = [];
  let releaseFirst;
  const firstDone = new Promise((resolve) => { releaseFirst = resolve; });

  const first = withSolveGate({ minIntervalMs: 0, now: clock.now, sleep: clock.sleep }, async () => {
    events.push('start#1');
    await firstDone;
    events.push('end#1');
  });
  const second = withSolveGate({ minIntervalMs: 0, now: clock.now, sleep: clock.sleep }, async () => {
    events.push('start#2');
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ['start#1'], '第二个解算必须排队，不能同时拉起两个浏览器');

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['start#1', 'end#1', 'start#2']);
});

test('F001 按退避序列重试，成功后返回参数', async () => {
  const clock = createClock();
  const attempts = [];
  const result = await runWithF001Retry(async (attempt) => {
    attempts.push(attempt);
    if (attempt < 2) throw new Error(F001_MESSAGE);
    return 'captcha-param';
  }, { delays: F001_RETRY_DELAYS_MS, now: clock.now, sleep: clock.sleep });

  assert.equal(result, 'captcha-param');
  assert.deepEqual(attempts, [0, 1, 2], '两次 F001 后第三次成功');
  assert.deepEqual(clock.sleeps, F001_RETRY_DELAYS_MS, '每次重试前都要退避');
});

test('非 F001 的失败不重试', async () => {
  let calls = 0;
  await assert.rejects(
    runWithF001Retry(async () => {
      calls += 1;
      throw new Error('captcha_timeout:60000');
    }, { delays: [20_000], sleep: async () => {} }),
    /captcha_timeout/
  );
  assert.equal(calls, 1, '超时是本地故障，重试只会白烧一次解算');
});

test('重试次数用尽后抛出最后一次的 F001', async () => {
  let calls = 0;
  await assert.rejects(
    runWithF001Retry(async () => {
      calls += 1;
      throw new Error(F001_MESSAGE);
    }, { delays: [1, 1], sleep: async () => {} }),
    /F001/
  );
  assert.equal(calls, 3, '首次 + 两次重试');
});

test('预算不够再跑一轮时不再重试', async () => {
  const clock = createClock(0);
  let calls = 0;
  await assert.rejects(
    runWithF001Retry(async () => {
      calls += 1;
      clock.advance(100_000);
      throw new Error(F001_MESSAGE);
    }, { delays: [40_000], budgetMs: 120_000, now: clock.now, sleep: clock.sleep }),
    /F001/
  );
  assert.equal(calls, 1, '100s + 40s 退避 + 15s 解算 已超 120s 预算');
  assert.deepEqual(clock.sleeps, []);
});

test('retryDelaysMs 传空数组可以关掉重试', async () => {
  let calls = 0;
  await assert.rejects(
    runWithF001Retry(async () => {
      calls += 1;
      throw new Error(F001_MESSAGE);
    }, { delays: [], sleep: async () => {} }),
    /F001/
  );
  assert.equal(calls, 1);
});
