'use strict';

// 回归来源:agy 会话 session-809bb12b 报
// `The input token count exceeds the maximum number of tokens allowed 1048576`。
// 实测根因不是对话历史累积,而是单个 2,789,035 字符的 HTML 附件里 40 个内嵌
// base64 data URI 占了 2,009,764 字符(72.1%)——模型看不见 base64 里的图像,
// 这些字节却吃满窗口。本文件锁住"剥载荷、留结构、不损坏原文"这三条。

const assert = require('node:assert/strict');
const test = require('node:test');

const { elideDataUris, elisionNotice } = require('../lib/server/chat-document-data-uri');
const { formatChatDocumentBlock } = require('../lib/server/chat-document-attachments');

test('剥离大载荷:保留 mime 前缀与周边标记,只换 base64 正文', () => {
  const payload = 'A'.repeat(5000);
  const result = elideDataUris(`<img alt="图" src="data:image/webp;base64,${payload}"><p>文案</p>`);

  assert.equal(result.count, 1);
  assert.equal(result.savedChars, 5000 - '[AIH-ELIDED-1:5000chars]'.length);
  assert.match(result.text, /^<img alt="图" src="data:image\/webp;base64,/, '周边标记必须逐字保留');
  assert.match(result.text, /\[AIH-ELIDED-1:5000chars\]"><p>文案<\/p>$/);
  assert.ok(!result.text.includes(payload), '载荷不得残留');
});

test('无 data URI 时逐字节原样返回', () => {
  const text = '附件正文\n第二行';
  const result = elideDataUris(text);
  assert.equal(result.text, text);
  assert.equal(result.count, 0);
  assert.equal(result.savedChars, 0);
});

test('小载荷不动:占位符自身有长度,小图剥离得不偿失', () => {
  const text = `<img src="data:image/png;base64,${'B'.repeat(64)}">`;
  assert.equal(elideDataUris(text).count, 0);
  assert.equal(elideDataUris(text).text, text);
});

test('短 base64 后面的正文不被吞掉', () => {
  // 载荷字符集刻意不含空白:否则 `QQ==\n\n  Hello` 会把 Hello 一起吃进载荷。
  const text = 'data:text/plain;base64,QQ==\n\n  Hello world';
  const result = elideDataUris(text, { minPayloadChars: 1 });
  assert.match(result.text, /Hello world$/, '正文必须完好');
});

test('多个载荷各自编号,披露语给出总量', () => {
  const text = [1, 2, 3].map((n) => `<img src="data:image/webp;base64,${String(n).repeat(1000)}">`).join('');
  const result = elideDataUris(text);
  assert.equal(result.count, 3);
  for (const n of [1, 2, 3]) assert.ok(result.text.includes(`[AIH-ELIDED-${n}:1000chars]`));
  assert.match(elisionNotice(result.count, result.savedChars), /含 3 处内嵌 base64 资源/);
});

test('附件块:剥离后追加披露语,模型不会误以为拿到了图片内容', () => {
  const block = formatChatDocumentBlock('page.html', `<img src="data:image/webp;base64,${'C'.repeat(3000)}">正文`);
  assert.match(block, /^附件 "page\.html"：\n/);
  assert.match(block, /（本附件含 1 处内嵌 base64 资源/);
  assert.match(block, /（附件结束）$/);
  assert.ok(!block.includes('C'.repeat(3000)));
});

test('附件块:没有内嵌资源时与旧行为逐字节一致', () => {
  assert.equal(formatChatDocumentBlock('a.txt', '普通文本'), '附件 "a.txt"：\n普通文本\n（附件结束）');
});
