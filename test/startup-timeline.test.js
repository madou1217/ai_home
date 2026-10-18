'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStartupTimeline, timeStep } = require('../lib/server/startup-timeline');

function fakeClock(startMs) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => { current += ms; }
  };
}

test('startup timeline reports every step, including small ones, so a gap made of many small steps stays visible', () => {
  const clock = fakeClock(1000);
  const timeline = createStartupTimeline({ now: clock.now, uptimeMs: () => clock.now() });
  for (const name of ['instanceLock', 'listenPort', 'codexClientVersion']) {
    clock.advance(40);
    timeline.mark(name);
  }

  assert.deepEqual(timeline.steps(), [
    { name: 'instanceLock', ms: 40 },
    { name: 'listenPort', ms: 40 },
    { name: 'codexClientVersion', ms: 40 }
  ]);
  const line = timeline.format();
  assert.match(line, /instanceLock 40ms, listenPort 40ms, codexClientVersion 40ms/);
  assert.match(line, /inside server 120ms/);
});

test('startup timeline shows the time spent before the server was entered, with the prelude breakdown', () => {
  // 进程启动后 800ms 才进入 server：这段在 server 内部看不到，必须由进程运行时长补上。
  const clock = fakeClock(800);
  const timeline = createStartupTimeline({
    now: clock.now,
    uptimeMs: () => clock.now(),
    preludeSteps: [{ name: 'stateIndex:codex', ms: 512.4 }, { name: 'broken' }, null]
  });
  clock.advance(200);
  timeline.mark('listen');

  const line = timeline.format();
  assert.match(line, /listening after 1000ms since process start/);
  // 800ms 里前置步骤占 512ms，其余 288ms 归为加载模块 + 顶层装配。
  assert.match(line, /before server 800ms \(load\+compose 288ms, stateIndex:codex 512ms\)/);
  assert.deepEqual(timeline.preludeSteps(), [{ name: 'stateIndex:codex', ms: 512 }]);
});

test('timeStep records the duration even when the step throws', () => {
  const clock = fakeClock(0);
  const steps = [];
  assert.equal(timeStep(steps, 'ok', () => { clock.advance(5); return 'value'; }, clock.now), 'value');
  assert.throws(() => timeStep(steps, 'fails', () => { clock.advance(7); throw new Error('boom'); }, clock.now), /boom/);
  assert.deepEqual(steps, [{ name: 'ok', ms: 5 }, { name: 'fails', ms: 7 }]);
});
