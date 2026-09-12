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
const { budgetedTurnInput, budgetHistoryItems, composeTurnPrompt } = require('../lib/server/chat-runtime/chat-harness-policy');
const { formatChatDocumentBlock } = require('../lib/server/chat-document-attachments');

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

test('历史 seed 超预算时保留连续尾部,不注入孤立 assistant', () => {
  const items = [
    { role: 'user', content: [{ type: 'input_text', text: '旧'.repeat(5000) }] },
    { role: 'assistant', content: [{ type: 'output_text', text: '答复' }] },
    { role: 'user', content: [{ type: 'input_text', text: '最新' }] }
  ];
  const result = budgetHistoryItems(items, 1000);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.items, [items[2]]);
  assert.ok(result.appliedTokens <= result.budgetTokens);
});

test('历史 seed 遇到过大消息时停止回溯,不跨 gap 保留孤立 assistant', () => {
  const items = [
    { role: 'user', content: [{ type: 'input_text', text: '较早但可用' }] },
    { role: 'user', content: [{ type: 'input_text', text: '过大'.repeat(5000) }] },
    { role: 'assistant', content: [{ type: 'output_text', text: '最新可用' }] }
  ];
  const result = budgetHistoryItems(items, 100);
  assert.deepEqual(result.items, []);
  assert.equal(result.truncated, true);
});

test('截断保住信封:块仍以（附件结束）收尾,字符数只描述正文', () => {
  // 回归:曾按整块长度切分,既掐掉结尾标记(模型收到未闭合的附件块),
  // 又把标题行算进"已装载字符数"。
  const block = formatChatDocumentBlock('x.html', '测'.repeat(800000));
  const result = applyDocumentTokenBudget({
    content: '', documentBlocks: [block], videoBlock: '', contextWindow: GEMINI_WINDOW
  });
  const out = result.documentBlocks[0];

  assert.ok(out.endsWith('（附件结束）'), '截断不得掐掉结尾标记');
  assert.ok(out.startsWith('附件 "x.html"：\n'), '标题行必须完整');
  const matched = /已装载前 (\d+) 字符，其余 (\d+) 字符未装载/.exec(out);
  assert.ok(matched, '必须给出装载/未装载字符数');
  const body = out.slice('附件 "x.html"：\n'.length, -'\n（附件结束）'.length);
  assert.equal(Number(matched[1]) + Number(matched[2]), 800000,
    '两数之和必须等于正文长度,不得把信封算作附件内容');
  assert.ok(body.startsWith('测'), '正文从头保留');
});

test('剥离披露语在截断后仍在:两条披露不冲突', () => {
  // 剥离披露语紧跟标题行,因此只截正文时它必然存活——模型不会既被告知
  // "结构逐字保留"又看不到自己被截断了。
  const block = formatChatDocumentBlock('page.html',
    `<img src="data:image/webp;base64,${'A'.repeat(9000)}">${'测'.repeat(800000)}`);
  const result = applyDocumentTokenBudget({
    content: '', documentBlocks: [block], videoBlock: '', contextWindow: GEMINI_WINDOW
  });
  const out = result.documentBlocks[0];

  assert.match(out, /含 1 处内嵌 base64 资源/, '剥离事实必须存活');
  assert.match(out, /其余 \d+ 字符未装载/, '截断事实必须同时在场');
  assert.ok(out.endsWith('（附件结束）'));
  assert.ok(!out.includes('A'.repeat(500)), 'base64 载荷不得残留');
  assert.ok(result.appliedTokens <= result.budgetTokens);
});
