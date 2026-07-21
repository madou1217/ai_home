'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createCodexInteractionObserver
} = require('../lib/cli/services/pty/codex-interaction-observer');

test('Codex CLI observer syncs a titled selector and applies only its advertised choice', async () => {
  const posts = [];
  const writes = [];
  let command = null;
  const observer = createCodexInteractionObserver({
    correlationId: 'correlation-1',
    accountRef: 'account-1',
    receiverUrl: 'http://127.0.0.1/hook',
    postJson: async (_url, payload) => {
      posts.push(payload);
      return { ok: true, json: command ? { ok: true, command } : { ok: true } };
    },
    writeInput: (input, options) => writes.push({ input, options })
  });

  const detected = observer.observe([
    'Additional safety checks\r\n',
    '› 1. Continue safely\r\n',
    '  2. Cancel\r\n'
  ].join(''));
  await observer.sync();

  assert.equal(detected.prompt.question, 'Additional safety checks');
  const promptPost = posts.find((payload) => payload.prompt);
  assert.equal(promptPost.promptRevision, 1);
  command = {
    deliveryId: 'delivery-1',
    promptId: detected.prompt.promptId,
    promptRevision: 1,
    choiceValue: '2'
  };
  await observer.sync();

  assert.deepEqual(writes, [{
    input: '2',
    options: { appendNewline: true, promptId: detected.prompt.promptId }
  }]);
  await observer.sync();
  assert.equal(posts.some((payload) => payload.resolvedDeliveryId === 'delivery-1'), true);
});

test('Codex CLI observer rejects stale or unknown WebUI choices', async () => {
  const writes = [];
  let activeCommand = null;
  const observer = createCodexInteractionObserver({
    correlationId: 'correlation-2',
    receiverUrl: 'http://127.0.0.1/hook',
    postJson: async () => ({ ok: true, json: { ok: true, command: activeCommand } }),
    writeInput: (...args) => writes.push(args)
  });
  const detected = observer.observe('Question?\n› 1. First\n  2. Second\n');
  activeCommand = {
    deliveryId: 'delivery-stale',
    promptId: detected.prompt.promptId,
    promptRevision: 99,
    choiceValue: '3'
  };
  await observer.sync();
  assert.deepEqual(writes, []);
});

test('Codex CLI observer does not post while no interaction state needs syncing', async () => {
  const posts = [];
  let intervalCallback = null;
  const observer = createCodexInteractionObserver({
    correlationId: 'correlation-idle',
    receiverUrl: 'http://127.0.0.1/hook',
    postJson: async (_url, payload) => {
      posts.push(payload);
      return { ok: true, json: { ok: true } };
    },
    setInterval: (callback) => {
      intervalCallback = callback;
      return { unref() {} };
    }
  });

  assert.equal(observer.start(), true);
  await observer.sync();
  intervalCallback();
  await Promise.resolve();

  assert.deepEqual(posts, []);
});

test('Codex CLI observer preserves CJK text rendered with absolute terminal columns', () => {
  const observer = createCodexInteractionObserver({
    correlationId: 'correlation-cjk',
    receiverUrl: 'http://127.0.0.1/hook'
  });

  const detected = observer.observe([
    '\u001b[1;1H测试说明？',
    '\u001b[2;1H› 1. 选项甲',
    '\u001b[3;3H2. 选项乙'
  ].join(''));

  assert.equal(detected.prompt.question, '测试说明？');
  assert.deepEqual(detected.prompt.options.map((option) => option.title), ['选项甲', '选项乙']);
});

test('Codex CLI observer clears a prompt after it is absent for consecutive terminal frames', async () => {
  const posts = [];
  const observer = createCodexInteractionObserver({
    correlationId: 'correlation-cleared',
    receiverUrl: 'http://127.0.0.1/hook',
    postJson: async (_url, payload) => {
      posts.push(payload);
      return { ok: true, json: { ok: true } };
    }
  });
  const detected = observer.observe('Question?\n› 1. First\n  2. Second\n');
  await observer.sync();

  assert.equal(observer.observe('\u001b[2J\u001b[HWorking'), null);
  const cleared = observer.observe('\u001b[2J\u001b[HStill working');
  await observer.sync();

  assert.equal(cleared.type, 'interactive-prompt-cleared');
  assert.equal(cleared.promptId, detected.prompt.promptId);
  assert.equal(posts.some((payload) => payload.clearedPromptId === detected.prompt.promptId), true);
});
