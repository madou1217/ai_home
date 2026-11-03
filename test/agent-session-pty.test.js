'use strict';

// PTY adapter：屏幕是脏的、提示会停留多帧，所以这里重点验三件事：
// 去重（一条提示只开一个交互）、映射（plan/choice/confirm 落到正确的 kind）、
// 失败关闭（读不到屏、屏幕变了、dispose 之后都不许瞎按键）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdapter } = require('../lib/agent-session/adapters/pty-tui');
const { normalizeInteractionRequest } = require('../lib/agent-session/contracts');
const { createEventBus } = require('../lib/agent-session/event-bus');
const { createInteractionRouter } = require('../lib/agent-session/interaction-router');
const { createAgentSession } = require('../lib/agent-session/session');

const QUESTION_SCREEN = [
  'Do you want to allow this command?',
  '❯ 1. Yes',
  '  2. No, and tell the model what to do differently'
].join('\n');

const PLAN_SCREEN = [
  'Implement this plan?',
  '',
  '› 1. Yes, and auto-accept edits',
  '  2. Yes, and manually approve edits',
  '  3. No, keep planning'
].join('\n');

const CONFIRM_SCREEN = 'Proceed with the change? (y/n)';
const ACK_SCREEN = 'Press Enter to continue';

function createHarness(options = {}) {
  const state = {
    screen: '',
    writes: [],
    screenListener: null,
    timers: [],
    clearedTimers: [],
    timeoutTimers: [],
    clearedTimeouts: []
  };
  const context = Object.assign({
    readScreen: () => state.screen,
    writeInput: (text) => { state.writes.push(text); },
    onScreen: (listener) => {
      state.screenListener = listener;
      return () => {
        if (state.screenListener === listener) state.screenListener = null;
      };
    },
    // 测试不跑真实定时器：轮询回调由用例显式触发，避免用例之间互相干扰。
    setInterval: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      state.timers.push(timer);
      return timer;
    },
    clearInterval: (timer) => { state.clearedTimers.push(timer); },
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      state.timeoutTimers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { state.clearedTimeouts.push(timer); }
  }, options.context || {});
  const adapter = createAdapter({
    sessionId: 's1',
    provider: options.provider || 'codex',
    transport: 'pty',
    context
  });
  const requests = [];
  const expirations = [];
  adapter.onInteractionRequest((request) => requests.push(request));
  adapter.onInteractionExpire((interactionId, reason) => expirations.push({ interactionId, reason }));
  return {
    adapter,
    state,
    requests,
    expirations,
    push(screen) {
      state.screen = screen;
      if (state.screenListener) state.screenListener();
    },
    tick() {
      for (const timer of state.timers) timer.fn();
    }
  };
}

test('open fails closed when the screen source is incomplete', async () => {
  for (const missing of ['readScreen', 'writeInput']) {
    const context = { readScreen: () => '', writeInput: () => {} };
    context[missing] = undefined;
    const adapter = createAdapter({ sessionId: 's1', provider: 'codex', transport: 'pty', context });
    await assert.rejects(
      () => adapter.open({}),
      (error) => {
        assert.equal(error.code, 'pty_screen_source_required');
        assert.deepEqual(error.details.missing, [missing]);
        return true;
      }
    );
  }
});

test('open refuses to pretend it can start a fresh harness session', async () => {
  const h = createHarness();
  await assert.rejects(
    () => h.adapter.open({ newSession: true }),
    (error) => error.code === 'pty_new_session_unsupported'
  );
});

test('the same prompt on screen for three frames opens exactly one interaction', async () => {
  const h = createHarness();
  await h.adapter.open({});
  h.push(QUESTION_SCREEN);
  h.push(QUESTION_SCREEN);
  h.push(QUESTION_SCREEN);
  assert.equal(h.requests.length, 1);
  const normalized = normalizeInteractionRequest(h.requests[0]);
  assert.equal(normalized.kind, 'question');
  assert.equal(normalized.payload.fields[0].type, 'single_select');
  assert.deepEqual(normalized.payload.fields[0].options.map((option) => option.value), ['1', '2']);
});

test('without a push channel the poll timer still finds the prompt', async () => {
  const h = createHarness({ context: { onScreen: undefined } });
  await h.adapter.open({});
  h.state.screen = ACK_SCREEN;
  assert.equal(h.requests.length, 0);
  h.tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].kind, 'approval');
});

test('a changed prompt opens a second interaction with a new id', async () => {
  const h = createHarness();
  await h.adapter.open({});
  h.push(QUESTION_SCREEN);
  h.push(CONFIRM_SCREEN);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].kind, 'question');
  assert.equal(h.requests[1].kind, 'approval');
  assert.notEqual(h.requests[0].interactionId, h.requests[1].interactionId);
});

test('a numbered choice answer writes the option key plus enter', async () => {
  const h = createHarness();
  await h.adapter.open({});
  h.push(QUESTION_SCREEN);
  h.adapter.respond(h.requests[0].interactionId, { action: 'submit', answers: { choice: '2' } });
  assert.deepEqual(h.state.writes, ['2\r']);
});

test('a claude-style selector is answered without enter', async () => {
  const h = createHarness({ provider: 'claude' });
  await h.adapter.open({});
  h.push(QUESTION_SCREEN);
  h.adapter.respond(h.requests[0].interactionId, { action: 'submit', answers: { choice: '1' } });
  assert.deepEqual(h.state.writes, ['1']);
});

test('a plan prompt maps to plan_confirmation and answers by option number', async () => {
  const h = createHarness();
  await h.adapter.open({});
  h.push(PLAN_SCREEN);
  assert.equal(h.requests[0].kind, 'plan_confirmation');
  h.adapter.respond(h.requests[0].interactionId, { action: 'submit', answers: { choice: '2' } });
  assert.deepEqual(h.state.writes, ['2\r']);
});

test('a y/n confirm maps to approval with allow/deny choices', async () => {
  const h = createHarness();
  await h.adapter.open({});
  h.push(CONFIRM_SCREEN);
  const normalized = normalizeInteractionRequest(h.requests[0]);
  assert.equal(normalized.kind, 'approval');
  assert.deepEqual(
    normalized.payload.choices.map((choice) => ({ id: choice.id, intent: choice.intent })),
    [{ id: 'y', intent: 'accept' }, { id: 'n', intent: 'deny' }]
  );
  h.adapter.respond(h.requests[0].interactionId, { choiceId: 'n' });
  assert.deepEqual(h.state.writes, ['n\r']);
});

test('an acknowledge prompt becomes a single-choice approval', async () => {
  const h = createHarness();
  await h.adapter.open({});
  h.push(ACK_SCREEN);
  assert.equal(h.requests[0].kind, 'approval');
  assert.deepEqual(h.requests[0].payload.choices.map((choice) => choice.id), ['enter']);
  h.adapter.respond(h.requests[0].interactionId, { choiceId: 'enter' });
  assert.deepEqual(h.state.writes, ['\r']);
});

test('an unparseable screen yields no interaction and does not throw', async () => {
  const h = createHarness();
  await h.adapter.open({});
  assert.doesNotThrow(() => {
    h.push('Here is what I did:');
    h.push('1. Read the file');
    h.push('2. Wrote the test');
    // 有问号、有编号，但没有选择光标 —— 这是模型回答，不是活跃选择器。
    h.push('Which approach?\n1. A\n2. B');
    h.push('');
  });
  assert.equal(h.requests.length, 0);
});

test('an answered prompt does not reopen until the screen goes clean', async () => {
  const h = createHarness();
  await h.adapter.open({});
  h.push(QUESTION_SCREEN);
  const first = h.requests[0];
  h.adapter.respond(first.interactionId, { action: 'submit', answers: { choice: '1' } });
  h.push(QUESTION_SCREEN);
  h.push(QUESTION_SCREEN);
  assert.equal(h.requests.length, 1);
  h.push('');
  h.push('');
  h.push(QUESTION_SCREEN);
  assert.equal(h.requests.length, 2);
  assert.notEqual(h.requests[1].interactionId, first.interactionId);
});

test('a redraw of the same prompt keeps the original interaction answerable', async () => {
  const h = createHarness();
  await h.adapter.open({});
  h.push(QUESTION_SCREEN);
  const id = h.requests[0].interactionId;
  h.push('');
  h.push('');
  h.push(QUESTION_SCREEN);
  assert.equal(h.requests.length, 1);
  h.adapter.respond(id, { action: 'submit', answers: { choice: '2' } });
  assert.deepEqual(h.state.writes, ['2\r']);
});

test('a prompt that disappears before it is answered cannot be answered later', async () => {
  const h = createHarness();
  await h.adapter.open({});
  h.push(QUESTION_SCREEN);
  const id = h.requests[0].interactionId;
  h.push('');
  h.push('');
  assert.throws(
    () => h.adapter.respond(id, { action: 'submit', answers: { choice: '1' } }),
    (error) => error.code === 'pty_interaction_stale'
  );
  assert.deepEqual(h.state.writes, []);
});

test('a prompt replaced by another retracts the old interaction', async () => {
  const h = createHarness();
  await h.adapter.open({});
  h.push(QUESTION_SCREEN);
  assert.equal(h.requests.length, 1);
  h.push(PLAN_SCREEN);
  assert.deepEqual(h.expirations, [{ interactionId: h.requests[0].interactionId, reason: 'prompt_replaced' }]);
});

test('a prompt that stays gone past the grace window is retracted', async () => {
  const h = createHarness();
  await h.adapter.open({});
  h.push(QUESTION_SCREEN);
  h.push('');
  h.push('');
  assert.equal(h.expirations.length, 0, '短暂擦屏不能立刻作废');
  assert.equal(h.state.timeoutTimers.length, 1);
  h.state.timeoutTimers[0].fn();
  assert.deepEqual(h.expirations, [{ interactionId: h.requests[0].interactionId, reason: 'prompt_gone' }]);
});

test('a redraw before the grace window keeps the interaction retractable later', async () => {
  const h = createHarness();
  await h.adapter.open({});
  h.push(QUESTION_SCREEN);
  h.push('');
  h.push('');
  h.push(QUESTION_SCREEN);
  assert.equal(h.expirations.length, 0);
  assert.equal(h.requests.length, 1);
});

test('declining a numbered choice is refused instead of guessing a key', async () => {
  const h = createHarness();
  await h.adapter.open({});
  h.push(QUESTION_SCREEN);
  assert.throws(
    () => h.adapter.respond(h.requests[0].interactionId, { action: 'decline' }),
    (error) => error.code === 'pty_decision_action_unsupported'
  );
  assert.deepEqual(h.state.writes, []);
});

test('prompt writes text with a newline and cancel sends the interrupt key', async () => {
  const h = createHarness();
  await h.adapter.open({});
  const result = await h.adapter.prompt({ text: 'fix the bug', turnId: 't1' });
  assert.equal(result.stopReason, 'submitted');
  await h.adapter.cancel('user');
  assert.deepEqual(h.state.writes, ['fix the bug\r', '\u0003']);
});

test('images are refused because a terminal cannot carry them', async () => {
  const h = createHarness();
  await h.adapter.open({});
  await assert.rejects(
    () => h.adapter.prompt({ text: 'look', images: [{ mimeType: 'image/png', data: 'x' }] }),
    (error) => error.code === 'pty_images_unsupported'
  );
  assert.deepEqual(h.state.writes, []);
});

test('dispose refuses new interactions, late answers and new prompts', async () => {
  const h = createHarness();
  await h.adapter.open({});
  h.push(QUESTION_SCREEN);
  const id = h.requests[0].interactionId;
  const lateScan = h.state.screenListener;
  h.adapter.dispose('done');
  h.state.screen = CONFIRM_SCREEN;
  assert.doesNotThrow(() => lateScan());
  assert.equal(h.requests.length, 1);
  assert.throws(
    () => h.adapter.respond(id, { action: 'submit', answers: { choice: '1' } }),
    (error) => error.code === 'pty_adapter_disposed'
  );
  await assert.rejects(
    () => h.adapter.prompt({ text: 'hi' }),
    (error) => error.code === 'pty_adapter_disposed'
  );
  assert.equal(h.state.clearedTimers.length, 1);
});

test('a repeated prompt reaches the router once and is answered through the session', async () => {
  const h = createHarness();
  const bus = createEventBus({ sessionId: 's1' });
  const router = createInteractionRouter({ sessionId: 's1', bus });
  const session = createAgentSession({ sessionId: 's1', adapter: h.adapter, bus, router });
  const seen = [];
  session.subscribe((event) => seen.push(event.type));
  await session.open({});
  h.push(QUESTION_SCREEN);
  h.push(QUESTION_SCREEN);
  h.push(QUESTION_SCREEN);
  assert.equal(router.pendingCount(), 1);
  const [pending] = router.pending();
  const resolved = session.respond(pending.interactionId, { action: 'submit', answers: { choice: '2' } });
  assert.equal(resolved.state, 'resolved');
  assert.deepEqual(h.state.writes, ['2\r']);
  assert.ok(seen.includes('interaction.requested'));
  assert.ok(seen.includes('interaction.resolved'));
  session.dispose('done');
});
