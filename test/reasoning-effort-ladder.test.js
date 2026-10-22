'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  alignReasoningEffort,
  normalizeEffortLadder
} = require('../lib/server/chat-runtime/reasoning-effort-ladder');

// 需求里给出的两个原始例子：倒排配对、不轮空、不越级。
test('alignment pairs the two ladders top-down', () => {
  const model = ['low', 'medium', 'high'];
  const sender = ['none', 'minimal', 'low', 'medium', 'high'];
  assert.equal(alignReasoningEffort('high', sender, model).effort, 'high');
  assert.equal(alignReasoningEffort('medium', sender, model).effort, 'medium');
  assert.equal(alignReasoningEffort('low', sender, model).effort, 'low');
  // 目标先耗尽：更弱的请求全部收敛到目标最低档，不轮空。
  assert.equal(alignReasoningEffort('minimal', sender, model).effort, 'low');
  assert.equal(alignReasoningEffort('none', sender, model).effort, 'low');
});

test('a narrower sender shifts the whole ladder up instead of landing on the same name', () => {
  const model = ['low', 'medium', 'high'];
  const sender = ['minimal', 'low'];
  assert.equal(alignReasoningEffort('low', sender, model).effort, 'high');
  assert.equal(alignReasoningEffort('minimal', sender, model).effort, 'medium');
  // 目标最低档不再被任何发送方档位选中。
  assert.ok(!['low', 'minimal'].map((effort) => alignReasoningEffort(effort, sender, model).effort)
    .includes('low'));
});

test('an unknown sender ladder aligns against the model ladder itself', () => {
  const model = ['low', 'medium', 'high'];
  assert.equal(alignReasoningEffort('medium', [], model).effort, 'medium');
  assert.equal(alignReasoningEffort('max', [], model).effort, 'high');
  assert.equal(alignReasoningEffort('none', [], model).effort, 'low');
});

test('alignment is monotonic and stable', () => {
  const model = ['low', 'high', 'max'];
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  let previous = -1;
  for (const requested of order) {
    const aligned = alignReasoningEffort(requested, [], model);
    assert.equal(aligned.ok, true);
    const position = model.indexOf(aligned.effort);
    assert.ok(position >= previous, `${requested} -> ${aligned.effort} went backwards`);
    previous = position;
    assert.equal(alignReasoningEffort(aligned.effort, [], model).effort, aligned.effort);
  }
});

test('every model tier stays reachable when the sender has at least as many tiers', () => {
  const model = ['low', 'medium', 'high', 'max'];
  const reached = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    .map((effort) => alignReasoningEffort(effort, [], model).effort));
  for (const tier of model) assert.ok(reached.has(tier), `${tier} is unreachable`);
});

test('sparse model ladders converge upward to the nearest available tier', () => {
  const sparse = ['medium', 'max'];
  assert.equal(alignReasoningEffort('high', [], sparse).effort, 'max');
  assert.equal(alignReasoningEffort('minimal', [], sparse).effort, 'medium');
  assert.equal(alignReasoningEffort('max', [], sparse).effort, 'max');
});

test('alignment reports its failure semantics instead of guessing', () => {
  const model = ['low', 'high'];
  assert.deepEqual(alignReasoningEffort('', [], model), { effort: '', ok: false, reason: 'no_intent' });
  assert.deepEqual(alignReasoningEffort('high', [], []), { effort: '', ok: false, reason: 'no_model_tiers' });
  assert.deepEqual(alignReasoningEffort('turbo', [], model), { effort: '', ok: false, reason: 'unknown_effort' });
});

test('catalog ladders drop unknown tiers and normalize order', () => {
  assert.deepEqual(normalizeEffortLadder(['high', 'turbo', 'low', 'low', '']), ['low', 'high']);
  assert.deepEqual(normalizeEffortLadder(undefined), []);
  // 顺序来自 Canonical 全序，与目录书写顺序无关。
  assert.deepEqual(normalizeEffortLadder(['max', 'low', 'medium']), ['low', 'medium', 'max']);
});
