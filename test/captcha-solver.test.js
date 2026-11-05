'use strict';

// 拖拽解算器的行为守卫：轨迹形状、拖动距离、失败重试、跨域兜底。
// 用假 CDP 驱动，不拉起浏览器（真机验证见 aliyun-captcha-forensics 的说明）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildApproachPath, buildDragPoints } = require('../lib/captcha/drag');
const { solveChallenge, waitForChallenge } = require('../lib/captcha');

const noSleep = async () => {};
const fixedRng = () => 0.5;

function sliderChallenge(overrides = {}) {
  return {
    kind: 'puzzle-drag',
    ready: true,
    slider: { x: 100, y: 400, width: 40, height: 40 },
    track: { x: 100, y: 400, width: 300, height: 40 },
    box: { x: 100, y: 200, width: 300, height: 200 },
    puzzle: {
      present: true,
      visible: true,
      rect: { x: 100, y: 200, width: 300, height: 200 },
      naturalWidth: 300,
      naturalHeight: 200,
      src: 'https://static-captcha.aliyuncs.com/p1.png'
    },
    trackClassName: 'puzzle',
    trackState: [],
    text: '拖动滑块完成拼图',
    question: '',
    ...overrides
  };
}

/** 控件探测的返回值：没有挑战时就长这样。 */
function probeSnapshot(overrides = {}) {
  const challenge = sliderChallenge(overrides);
  return {
    settled: false,
    outcome: null,
    slider: challenge.slider,
    track: challenge.track,
    box: challenge.box,
    puzzle: challenge.puzzle,
    trackClassName: challenge.trackClassName,
    trackState: challenge.trackState,
    text: challenge.text,
    question: challenge.question,
    ...overrides
  };
}

/**
 * 假 CDP：Runtime.evaluate 分两种 —— 带 __aihCaptchaOutcome 的是控件探测，
 * 其余是缺口偏移；Input.dispatchMouseEvent 只记录。
 */
function createFakeCdp(options = {}) {
  const events = [];
  let dragCount = 0;
  const cdp = {
    events,
    get dragCount() { return dragCount; },
    send: async (method, params = {}) => {
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression || '');
        if (expression.includes('__aihCaptchaOutcome')) {
          return { result: { value: options.probe({ dragCount, expression }) } };
        }
        return { result: { value: options.offset({ dragCount, expression }) } };
      }
      if (method === 'Input.dispatchMouseEvent') {
        events.push(params);
        if (params.type === 'mouseReleased') dragCount += 1;
        return {};
      }
      return {};
    }
  };
  return cdp;
}

test('拖动轨迹单调、落点精确、带过冲回弹', () => {
  const points = buildDragPoints({ distance: 173, rng: fixedRng });
  assert.ok(points.length >= 12, `轨迹点太少（${points.length}）`);
  // 主体段单调不减；最后三段是「过冲 → 回弹 → 落点」，允许回退。
  let previous = 0;
  for (const point of points.slice(0, -3)) {
    assert.ok(point.dx >= previous, '主体轨迹必须单调不减，否则会被判成抖动');
    previous = point.dx;
  }
  assert.equal(points[points.length - 1].dx, 173, '最后一点必须精确落在目标上');
  assert.ok(Math.max(...points.map((p) => p.dx)) > 173, '必须有少量过冲');
  for (const point of points) {
    assert.ok(Math.abs(point.dy) <= 2, `纵向漂移过大（${point.dy}）`);
  }
});

test('接近轨迹从远处起手、落在把手上', () => {
  const points = buildApproachPath({ target: { x: 120, y: 420 }, rng: fixedRng });
  assert.equal(points.length, 45);
  const first = points[0];
  const last = points[points.length - 1];
  assert.ok(Math.hypot(first.x - 120, first.y - 420) > 100, '起点必须离目标足够远');
  assert.ok(Math.abs(last.x - 120) < 4 && Math.abs(last.y - 420) < 4, '轨迹终点要落在把手上');
});

test('拼图挑战：按缺口偏移拖动，成功后返回 verified', async () => {
  const cdp = createFakeCdp({
    probe: ({ dragCount }) => (dragCount > 0
      ? { settled: true, outcome: { ok: true }, trackState: ['verified'] }
      : { settled: false, outcome: null, trackState: [] }),
    offset: () => ({ ok: true, offset: 173, naturalWidth: 300, displayWidth: 300 })
  });
  const result = await solveChallenge(cdp, 's1', sliderChallenge(), { sleep: noSleep, rng: fixedRng });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'puzzle-drag');
  assert.equal(result.distance, 173);
  assert.equal(result.attempts, 1);

  const pressed = cdp.events.findIndex((event) => event.type === 'mousePressed');
  const released = cdp.events.findIndex((event) => event.type === 'mouseReleased');
  assert.ok(pressed > 0 && released > pressed, '必须先按下再释放');
  const press = cdp.events[pressed];
  assert.deepEqual({ x: press.x, y: press.y }, { x: 120, y: 420 }, '必须按在把手中心');
  assert.equal(press.buttons, 1);
  const moves = cdp.events.slice(pressed + 1, released);
  assert.ok(moves.length >= 12, '拖动过程必须有轨迹');
  assert.ok(moves.every((event) => event.buttons === 1), '拖动中的移动必须带左键位');
  const release = cdp.events[released];
  assert.ok(Math.abs(release.x - (120 + 173)) < 2, '释放点要在缺口位置');
  assert.equal(release.buttons, 0);
});

test('缺口超出滑轨时按最大可拖距离截断', async () => {
  const cdp = createFakeCdp({
    probe: ({ dragCount }) => (dragCount > 0
      ? { settled: true, outcome: { ok: true }, trackState: ['verified'] }
      : { settled: false, outcome: null, trackState: [] }),
    offset: () => ({ ok: true, offset: 999 })
  });
  const result = await solveChallenge(cdp, 's1', sliderChallenge(), { sleep: noSleep, rng: fixedRng });
  assert.equal(result.distance, 260, '滑轨 300 - 把手 40 = 260');
});

test('拼图块自带初始偏移时按差值拖，不会拖过头', async () => {
  const cdp = createFakeCdp({
    probe: ({ dragCount }) => (dragCount > 0
      ? { settled: true, outcome: { ok: true }, trackState: ['verified'] }
      : { settled: false, outcome: null, trackState: [] }),
    offset: () => ({ ok: true, offset: 137 })
  });
  const challenge = sliderChallenge({
    puzzle: {
      ...sliderChallenge().puzzle,
      rect: { x: 130, y: 200, width: 300, height: 200 }
    }
  });
  const result = await solveChallenge(cdp, 's1', challenge, { sleep: noSleep, rng: fixedRng });
  assert.equal(result.distance, 107, '缺口 137 - 初始左偏 30 = 107');
});

test('只有滑轨时拖到最右边', async () => {
  const cdp = createFakeCdp({
    probe: ({ dragCount }) => (dragCount > 0
      ? { settled: true, outcome: { ok: true }, trackState: ['verified'] }
      : { settled: false, outcome: null, trackState: [] }),
    offset: () => ({ ok: false, reason: 'should_not_be_called' })
  });
  const challenge = sliderChallenge({ kind: 'slide-to-end', puzzle: null, trackClassName: '' });
  const result = await solveChallenge(cdp, 's1', challenge, { sleep: noSleep, rng: fixedRng });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'slide-to-end');
  assert.equal(result.distance, 260);
});

test('画布被跨域污染时用 data URL 兜底', async () => {
  let offsetCalls = 0;
  const cdp = createFakeCdp({
    probe: ({ dragCount }) => (dragCount > 0
      ? { settled: true, outcome: { ok: true }, trackState: ['verified'] }
      : { settled: false, outcome: null, trackState: [] }),
    offset: ({ expression }) => {
      offsetCalls += 1;
      if (expression.includes('data:image/png;base64,')) return { ok: true, offset: 88 };
      return { ok: false, reason: 'tainted_canvas', src: 'https://static-captcha.aliyuncs.com/x.png' };
    }
  });
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => Buffer.from([1, 2, 3, 4])
  });
  const result = await solveChallenge(cdp, 's1', sliderChallenge(), {
    sleep: noSleep,
    rng: fixedRng,
    fetchImpl
  });
  assert.equal(result.ok, true);
  assert.equal(result.distance, 88);
  assert.equal(offsetCalls, 2, '第一次污染、第二次用 data URL 重算');
});

test('拖错了会自动换图重试一次', async () => {
  const cdp = createFakeCdp({
    probe: ({ dragCount }) => {
      if (dragCount === 0) return probeSnapshot();
      if (dragCount === 1) {
        // 拖错：SDK 换了一张图，并标记 fail。
        return probeSnapshot({
          trackState: ['fail'],
          puzzle: { ...sliderChallenge().puzzle, src: 'https://static-captcha.aliyuncs.com/p2.png' }
        });
      }
      return { settled: true, outcome: { ok: true }, trackState: ['verified'], puzzle: { src: 'https://static-captcha.aliyuncs.com/p3.png' } };
    },
    offset: () => ({ ok: true, offset: 90 })
  });
  const result = await solveChallenge(cdp, 's1', sliderChallenge(), {
    sleep: noSleep,
    rng: fixedRng,
    maxAttempts: 2
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(cdp.dragCount, 2);
});

test('两次都失败就返回 failed，不无限重试', async () => {
  const cdp = createFakeCdp({
    probe: ({ dragCount }) => {
      if (dragCount === 0) return probeSnapshot();
      return probeSnapshot({
        trackState: ['fail'],
        puzzle: { ...sliderChallenge().puzzle, src: `https://static-captcha.aliyuncs.com/p${dragCount + 1}.png` }
      });
    },
    offset: () => ({ ok: true, offset: 90 })
  });
  const result = await solveChallenge(cdp, 's1', sliderChallenge(), {
    sleep: noSleep,
    rng: fixedRng,
    maxAttempts: 2
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'failed');
  assert.equal(cdp.dragCount, 2);
});

test('不认识的挑战类型要明确抛出，不能假装解过', async () => {
  const cdp = createFakeCdp({ probe: () => ({}), offset: () => ({ ok: false }) });
  await assert.rejects(
    () => solveChallenge(cdp, 's1', { kind: 'text-click' }, { sleep: noSleep }),
    /captcha_unsupported:text-click/
  );
});

test('换厂商只需换 profile，解算流程不动', async () => {
  const used = [];
  const profile = {
    name: 'other',
    probe: '(() => ({ settled: false, question: "点选文字" }))()',
    classify: (snapshot) => ({ ...snapshot, kind: 'text-click', ready: true }),
    buildPuzzleOffsetExpression: () => '({ ok: true, offset: 1 })'
  };
  const cdp = {
    send: async (method, params = {}) => {
      used.push(params.expression);
      return { result: { value: { settled: false, question: '点选文字' } } };
    }
  };
  const challenge = await waitForChallenge(cdp, 's1', { sleep: noSleep, timeoutMs: 1_000, profile });
  assert.equal(challenge.kind, 'text-click');
  assert.ok(used.includes(profile.probe), '必须使用 profile 自己的探测表达式');
});

test('无痕验证直接通过时不等挑战', async () => {
  const cdp = createFakeCdp({
    probe: () => ({ settled: true, outcome: { ok: true }, slider: null, track: null }),
    offset: () => ({ ok: false })
  });
  const challenge = await waitForChallenge(cdp, 's1', { sleep: noSleep, timeoutMs: 5_000 });
  assert.equal(challenge, null);
});

test('拼图图片没加载完时继续等，加载完再返回挑战', async () => {
  const snapshots = [
    {
      settled: false,
      slider: { x: 100, y: 400, width: 40, height: 40 },
      track: { x: 100, y: 400, width: 300, height: 40 },
      trackClassName: 'puzzle',
      puzzle: { present: true, visible: true, rect: null, naturalWidth: 0, naturalHeight: 0 }
    },
    {
      settled: false,
      slider: { x: 100, y: 400, width: 40, height: 40 },
      track: { x: 100, y: 400, width: 300, height: 40 },
      trackClassName: 'puzzle',
      puzzle: { present: true, visible: true, rect: { x: 100, y: 200, width: 300, height: 200 }, naturalWidth: 300, naturalHeight: 200 }
    }
  ];
  let index = 0;
  const cdp = createFakeCdp({
    probe: () => snapshots[Math.min(index++, snapshots.length - 1)],
    offset: () => ({ ok: false })
  });
  const challenge = await waitForChallenge(cdp, 's1', { sleep: noSleep, timeoutMs: 5_000 });
  assert.equal(challenge.kind, 'puzzle-drag');
  assert.equal(index, 2, '第一次没就绪，第二次才拿到');
});
