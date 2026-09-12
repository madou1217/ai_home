'use strict';

// 传输上限(字符)与上游窗口(token)必须分开守。剥离内嵌 base64 解决了实报的那一例,
// 但 950,000 字符以下仍有一整条漏网带:80 万字符的中文文档约 80 万 token,
// 能通过字符检查、照样被上游以 input token count exceeds 拒绝。
// 本文件锁住那道独立的 token 闸:超预算必须裁剪并如实披露,窗口未知时不猜。

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyDocumentTokenBudget, estimateTextTokens, resolveBudgetTokens
} = require('../lib/server/chat-runtime/chat-document-budget');
const { budgetedTurnInput, composeTurnPrompt } = require('../lib/server/chat-runtime/chat-harness-policy');

const GEMINI_WINDOW = 1048576;

test('估算保守:CJK 按 1 token/字符,不得低估', () => {
  assert.equal(estimateTextTokens('测'.repeat(1000)), 1000);
  assert.ok(estimateTextTokens('a'.repeat(1000)) <= 250, 'ASCII 约 4 字符/token');
  assert.equal(estimateTextTokens(''), 0);
  assert.equal(estimateTextTokens(undefined), 0);
});

test('预算按窗口百分比,默认为 60%(要给历史与回答留地方)', () => {
  assert.equal(resolveBudgetTokens(GEMINI_WINDOW), Math.floor(GEMINI_WINDOW * 0.6));
  assert.equal(resolveBudgetTokens(GEMINI_WINDOW, 80), Math.floor(GEMINI_WINDOW * 0.8));
  assert.equal(resolveBudgetTokens(0), 0, '窗口未知时无预算');
});

test('未超预算时原样通过', () => {
  const result = applyDocumentTokenBudget({
    content: '问题', documentBlocks: ['短文档'], videoBlock: '', contextWindow: GEMINI_WINDOW
  });
  assert.deepEqual(result.documentBlocks, ['短文档']);
  assert.equal(result.truncatedBlocks, 0);
  assert.equal(result.droppedBlocks, 0);
});

test('漏网带:80 万字符中文被裁到预算内,并如实披露截断', () => {
  const doc = '测'.repeat(800000);
  const result = applyDocumentTokenBudget({
    content: '问题', documentBlocks: [doc], videoBlock: '', contextWindow: GEMINI_WINDOW
  });

  assert.equal(result.truncatedBlocks, 1);
  assert.ok(result.originalTokens > result.budgetTokens, '前置条件:原输入本就超预算');
  assert.ok(result.appliedTokens <= result.budgetTokens,
    `裁剪后必须落在预算内(${result.appliedTokens} > ${result.budgetTokens})`);
  assert.match(result.documentBlocks[0], /已装载前 \d+ 字符/);
  assert.match(result.documentBlocks[0], /不要假设你已看过全文/);
});

test('多块:装不下的整块让位,不产生半截无标注的文本', () => {
  const big = '测'.repeat(700000);
  const result = applyDocumentTokenBudget({
    content: '', documentBlocks: [big, '测'.repeat(700000), '第三块'],
    videoBlock: '', contextWindow: GEMINI_WINDOW
  });
  assert.ok(result.droppedBlocks >= 1, '应有整块未装载');
  assert.ok(result.appliedTokens <= result.budgetTokens);
  for (const block of result.documentBlocks) {
    const intact = block === big || block === '第三块';
    assert.ok(intact || /未装载/.test(block), '被裁的块必须带披露语');
  }
});

test('窗口未知时不猜:保持原输入,交由传输层上限兜底', () => {
  const doc = '测'.repeat(800000);
  const result = applyDocumentTokenBudget({
    content: '', documentBlocks: [doc], videoBlock: '', contextWindow: undefined
  });
  assert.deepEqual(result.documentBlocks, [doc]);
  assert.equal(result.budgetTokens, 0);
});

test('policy 入口:未超预算返回 null,超预算重建 prompt 且分量顺序不变', () => {
  const small = { parts: { content: '问题', documentBlocks: ['短'], videoBlock: '' } };
  assert.equal(budgetedTurnInput(small, GEMINI_WINDOW), null, '未超预算不得改动输入');

  const parts = { content: '问题', documentBlocks: ['测'.repeat(800000)], videoBlock: '视频说明' };
  const budgeted = budgetedTurnInput({ parts }, GEMINI_WINDOW);
  assert.ok(budgeted, '超预算必须返回裁剪结果');
  assert.equal(budgeted.prompt, composeTurnPrompt(budgeted.parts));
  assert.match(budgeted.prompt, /^问题\n\n/, '正文仍在最前');
  assert.match(budgeted.prompt, /视频说明$/, '视频说明仍在最后');
  assert.ok(budgeted.budget.appliedTokens <= budgeted.budget.budgetTokens);
});

test('policy 入口:没有文档块时不介入', () => {
  assert.equal(budgetedTurnInput({ parts: { content: 'x', documentBlocks: [], videoBlock: '' } }, GEMINI_WINDOW), null);
  assert.equal(budgetedTurnInput({ parts: undefined }, GEMINI_WINDOW), null);
});
