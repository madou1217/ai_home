'use strict';

// 驱动级接线回归:剥离与预算都是 launch() 里的一个步骤,顺序错了就会静默失效
// (预算必须在 resolveSettings 之后——model_context_window 才就位——且在提交之前)。
// 纯函数测试覆盖不到这条顺序,本文件用假 client 抓住真正提交给 harness 的 turn/start。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createCodexDriverEntry } = require('../lib/server/chat-runtime/codex-session-driver');

const THREAD = 'native-thread-1';
const WINDOW = 1048576;

function fakeClient(calls) {
  return {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/resume') return { thread: { id: THREAD } };
      if (method === 'turn/start') return { turn: { id: 'native-turn-1' } };
      return {};
    },
    bindTurn() {}, unbindTurn() {}, waitForReconnect() { return new Promise(() => {}); }
  };
}

// chat 会话交给驱动时 provider 已被改写成 codex(见 chat-runtime-composition),
// workspaceMode 仍是 chat —— 这正是 agy 会话在生产里的形状。
function chatDriver(calls, projectPath) {
  return createCodexDriverEntry({
    session: {
      sessionId: 's1', provider: 'codex', executionAccountRef: 'acct-1', projectPath,
      runtimeBinding: { nativeSessionId: THREAD },
      policy: { workspaceMode: 'chat', approvalMode: 'confirm', model: 'gemini-3.8-flash-high' }
    },
    runtime: {
      provider: 'codex', runtimeScope: 'codex:acct-1', generation: 1,
      version: 'codex-cli test', fingerprint: 'f1'
    },
    clientFactory: () => fakeClient(calls),
    modelCatalog: {
      async prewarm() {}, async list() { return []; },
      async resolveTurnSettings() {
        return {
          model: 'gemini-3.8-flash-high', reasoningEffort: '',
          threadConfig: { model_context_window: WINDOW }
        };
      }
    },
    eventSink: async () => {}, transientEventSink: async () => {},
    onNativeSessionBound: async () => {}, onNativeTurnStarted: async () => {}
  });
}

async function submittedText(t, fileName, fileText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-driver-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, fileText, 'utf8');

  const calls = [];
  const turn = chatDriver(calls, dir).driver.startTurn({
    sessionId: 's1', runId: 'run-1', imagePaths: [file],
    command: { payload: { content: '这个页面什么风格？' } }
  });
  let rejection = null;
  turn.catch((error) => { rejection = error; });
  for (let i = 0; i < 60 && !calls.some((call) => call.method === 'turn/start'); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const started = calls.find((call) => call.method === 'turn/start');
  assert.ok(started, `turn/start 未发出; 调用:[${calls.map((c) => c.method).join(',')}]`
    + ` 拒因:${rejection && (rejection.code || rejection.message)}`);
  return started.params.input.map((part) => part.text || '').join('');
}

test('提交给 harness 的 turn/start 已剥离内嵌 base64', async (t) => {
  const text = await submittedText(t, 'page.html',
    `<img src="data:image/webp;base64,${'A'.repeat(60000)}">${'测'.repeat(20)}`);

  assert.match(text, /\[AIH-ELIDED-1:60000chars\]/, '占位符必须出现在真正提交的输入里');
  assert.ok(!text.includes('A'.repeat(1000)), 'base64 载荷不得进入提交');
  assert.match(text, /含 1 处内嵌 base64 资源/, '剥离事实必须随输入送达');
  assert.match(text, /^这个页面什么风格？/, '用户正文仍在最前');
});

test('超预算的纯文本附件在提交前被裁剪:证明预算在 resolveSettings 之后生效', async (t) => {
  // 不含 base64,剥离对它无效——只有 token 预算能救。预算取自 resolveSettings
  // 写入的 model_context_window,所以这条断言同时锁住了两步的先后顺序。
  const text = await submittedText(t, 'spec.md', '规格说明书正文。'.repeat(100000));

  assert.match(text, /其余 \d+ 字符未装载/, '超预算必须在提交前被裁剪并披露');
  assert.ok(text.endsWith('（附件结束）'), '裁剪后仍须是闭合的附件块');
  assert.ok(text.length < 800000, `提交的输入应已缩短(实际 ${text.length})`);
});
