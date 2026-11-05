'use strict';

// 回归守卫（2026-11-04）：app-server 的答案以前只从会话库读，DB 在 turn 结束时才
// 落盘 —— `aih zcode -p` 因此永远看不到流式输出。桌面端实际走的是 v4 会话帧：
//   row.appended / row.upserted（assistantText 整行）
//   row.delta {path:"text", append}
// 这里锁住「帧 → 增量文本」的纯逻辑（不依赖 CLI/网络）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createZcodeConversationStream } = require('../lib/cli/services/ai-cli/zcode-conversation-stream');

function frame(payload) {
  return { payload };
}

test('assistantText 行先 appended 再逐条 row.delta，增量按顺序输出', () => {
  const chunks = [];
  const stream = createZcodeConversationStream({ onText: (text) => chunks.push(text) });
  stream.acceptFrame(frame({
    kind: 'deltas',
    deltas: [{
      op: 'row.appended',
      row: { rowId: 4, kind: 'assistantText', text: '', state: 'streaming' }
    }]
  }));
  stream.acceptFrame(frame({
    kind: 'deltas',
    deltas: [
      { op: 'row.delta', rowId: 4, path: 'text', append: '你好' },
      { op: 'row.delta', rowId: 4, path: 'text', append: '，世界' }
    ]
  }));
  assert.deepEqual(chunks, ['你好', '，世界']);
  assert.equal(stream.getText(), '你好，世界');
  assert.equal(stream.isComplete(), false);
  stream.acceptFrame(frame({
    kind: 'deltas',
    deltas: [{ op: 'row.upserted', row: { rowId: 4, kind: 'assistantText', text: '你好，世界', state: 'complete' } }]
  }));
  assert.equal(stream.getText(), '你好，世界');
  assert.equal(stream.isComplete(), true);
});

test('已经流出内容后收到整行 upserted，不重复输出', () => {
  const chunks = [];
  const stream = createZcodeConversationStream({ onText: (text) => chunks.push(text) });
  stream.acceptFrame(frame({
    kind: 'deltas',
    deltas: [{ op: 'row.delta', rowId: 1, path: 'text', append: 'abc' }]
  }));
  stream.acceptFrame(frame({
    kind: 'deltas',
    deltas: [{ op: 'row.upserted', row: { rowId: 1, kind: 'assistantText', text: 'abcdef', state: 'complete' } }]
  }));
  assert.deepEqual(chunks, ['abc', 'def']);
  assert.equal(stream.getText(), 'abcdef');
});

test('初始快照的 rows.window 也能还原文本', () => {
  const chunks = [];
  const stream = createZcodeConversationStream({ onText: (text) => chunks.push(text) });
  stream.acceptFrame(frame({
    kind: 'snapshot',
    snapshot: {
      rows: {
        window: [
          { rowId: 1, kind: 'userInput', text: '用户问题' },
          { rowId: 2, kind: 'assistantText', text: '历史答案', state: 'complete' }
        ]
      }
    }
  }));
  assert.deepEqual(chunks, ['历史答案']);
  assert.equal(stream.getText(), '历史答案');
  assert.equal(stream.isComplete(), true);
});

test('多段 assistantText（工具调用前后）之间补换行，非 assistantText 行忽略', () => {
  const chunks = [];
  const stream = createZcodeConversationStream({ onText: (text) => chunks.push(text) });
  stream.acceptFrame(frame({
    kind: 'deltas',
    deltas: [
      { op: 'row.appended', row: { rowId: 1, kind: 'assistantText', text: '第一段', state: 'complete' } },
      { op: 'row.appended', row: { rowId: 2, kind: 'toolCall', text: '不该出现' } },
      { op: 'row.appended', row: { rowId: 3, kind: 'assistantText', text: '第二段', state: 'complete' } }
    ]
  }));
  assert.deepEqual(chunks, ['第一段', '\n', '第二段']);
  assert.equal(stream.getText(), '第一段\n第二段');
  assert.equal(stream.isComplete(), true);
});

test('更短的 upserted（回放窗口截断）不回退已输出文本', () => {
  const chunks = [];
  const stream = createZcodeConversationStream({ onText: (text) => chunks.push(text) });
  stream.acceptFrame(frame({
    kind: 'deltas',
    deltas: [{ op: 'row.appended', row: { rowId: 1, kind: 'assistantText', text: '完整答案', state: 'streaming' } }]
  }));
  stream.acceptFrame(frame({
    kind: 'deltas',
    deltas: [{ op: 'row.upserted', row: { rowId: 1, kind: 'assistantText', text: '完整', state: 'streaming' } }]
  }));
  assert.deepEqual(chunks, ['完整答案']);
  assert.equal(stream.getText(), '完整答案');
});
