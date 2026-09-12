'use strict';

// 端到端(文本管线)回归:从磁盘上的真实附件文件出发,走 turn 输入组装 + token 预算,
// 断言交给 harness 的 prompt 能装进上游窗口。
// 复现的是 agy 会话 session-809bb12b 的故障形状:一个内嵌大量 base64 图片的 HTML,
// 原样内联约 877K tokens,被 gemini 以 1,048,576 上限拒绝。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { budgetedTurnInput, sessionAttachmentTurnInput } = require('../lib/server/chat-runtime/chat-harness-policy');
const { estimateTextTokens } = require('../lib/server/chat-runtime/chat-document-budget');

const GEMINI_WINDOW = 1048576;
const chatSession = { policy: { workspaceMode: 'chat' }, projectPath: '/repo' };

function writeFixture(t, name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-window-fit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

// 故障形状:页面骨架 + 40 张内嵌 base64 图片,base64 占绝大多数字节。
function pageWithEmbeddedImages(imageCount, payloadChars) {
  const cards = [];
  for (let index = 0; index < imageCount; index += 1) {
    cards.push(`<figure class="card"><img alt="产品图 ${index}" `
      + `src="data:image/webp;base64,${'Zm9vYmFy'.repeat(Math.ceil(payloadChars / 8)).slice(0, payloadChars)}">`
      + `<figcaption>第 ${index} 号产品，定价说明与文案</figcaption></figure>`);
  }
  return `<!doctype html>\n<html lang="zh-CN"><head><style>.card{border-radius:12px}</style></head>`
    + `<body><h1>官网首页</h1>${cards.join('')}</body></html>`;
}

test('内嵌 base64 的大页面:原样约 88 万 token,经管线后装进 1,048,576 窗口', (t) => {
  const html = pageWithEmbeddedImages(40, 50000);
  const file = writeFixture(t, 'page.html', html);

  const inlineTokens = estimateTextTokens(html);
  assert.ok(inlineTokens > GEMINI_WINDOW * 0.6,
    `前置条件:原文必须超出预算才有意义(实际 ${inlineTokens})`);

  const turnInput = sessionAttachmentTurnInput(chatSession, '这个页面的设计风格是什么？', [file]);
  const budgeted = budgetedTurnInput(turnInput, GEMINI_WINDOW);
  const prompt = budgeted ? budgeted.prompt : turnInput.prompt;

  assert.ok(estimateTextTokens(prompt) < GEMINI_WINDOW,
    `最终 prompt 必须装进窗口(实际 ${estimateTextTokens(prompt)})`);
  assert.ok(!prompt.includes('Zm9vYmFy'.repeat(100)), 'base64 载荷不得残留');
  assert.match(prompt, /\[AIH-ELIDED-1:50000chars\]/, '占位符必须在位');
  assert.match(prompt, /第 39 号产品/, '文案必须完整保留到最后一张图');
  assert.match(prompt, /border-radius:12px/, '样式必须保留');
  assert.match(prompt, /^这个页面的设计风格是什么？/, '用户正文仍在最前');
});

test('纯文本大附件(无内嵌资源):由 token 预算兜住,并如实披露截断', (t) => {
  // 剥离 base64 对它无效——这条路只能靠预算闸,正是顾问点名的漏网带。
  const file = writeFixture(t, 'spec.md', '规格说明书正文。'.repeat(100000));

  const turnInput = sessionAttachmentTurnInput(chatSession, '总结要点', [file]);
  assert.ok(estimateTextTokens(turnInput.prompt) > GEMINI_WINDOW * 0.6, '前置条件:超预算');

  const budgeted = budgetedTurnInput(turnInput, GEMINI_WINDOW);
  assert.ok(budgeted, '必须介入');
  assert.ok(estimateTextTokens(budgeted.prompt) <= Math.floor(GEMINI_WINDOW * 0.6));
  assert.match(budgeted.prompt, /未装载/, '截断必须如实披露');
});

test('小附件:管线不介入,内容逐字保留', (t) => {
  const file = writeFixture(t, 'note.txt', '只有一句话的附件。');
  const turnInput = sessionAttachmentTurnInput(chatSession, '看看这个', [file]);

  assert.equal(budgetedTurnInput(turnInput, GEMINI_WINDOW), null, '未超预算不得改动');
  assert.match(turnInput.prompt, /只有一句话的附件。/);
  assert.ok(!turnInput.prompt.includes('AIH-ELIDED'), '不得凭空插入占位符');
});
