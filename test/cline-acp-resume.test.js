'use strict';

// 引擎级回归（真实子进程 + 真实文件 transcript，不 mock 流）：
// cline 续聊走 ACP 通道时，「完成」必须等 `session/prompt` 结算（整轮含工具循环都跑完），
// 而不是 transcript 的第一次追加 —— cline 的 transcript 是**增量追加**的（工具调用/工具
// 结果各写一条），旧实现在第一次追加就收尾：工具轮被截断成 `:::tool` 块、模型最终答复
// 永远等不到（2026-10-16 真机证据，见 lib/server/native-session-chat.js 的 ACP 收尾注释）。
//
// 假 cline 按 ACP 讲协议：initialize → authenticate（记录方法）→ session/load →
// session/prompt（先写「部分 transcript」→ 400ms 后写最终文本 → 才回 stopReason）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { spawnNativeSessionStream } = require('../lib/server/native-session-chat');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');
const { providersDocument, clineAuth } = require('./helpers/cline-credential');

const SESSION_ID = '1792125143839_acp1';

const FIXTURE_SOURCE = String.raw`
'use strict';
// 假 cline --acp：协议形状与 2026-10-16 真机捕获一致（NDJSON over stdio）。
const fs = require('node:fs');
const path = require('node:path');
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const messagesPath = () => String(process.env.FAKE_CLINE_MESSAGES_PATH || '');
const authMarkerPath = () => String(process.env.FAKE_CLINE_AUTH_MARKER || '');
const readDoc = () => {
  try { return JSON.parse(fs.readFileSync(messagesPath(), 'utf8')); } catch (_error) { return { messages: [] }; }
};
const writeDoc = (doc) => fs.writeFileSync(messagesPath(), JSON.stringify(doc));
let buf = '';
let sessionId = '';
const handle = (msg) => {
  if (typeof msg.method !== 'string') return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [
        { id: 'cline', name: 'Sign in with Cline' },
        { id: 'cline-pass', name: 'Sign in with ClinePass' }
      ]
    } });
    return;
  }
  if (msg.method === 'authenticate') {
    const methodId = String((msg.params || {}).methodId || '');
    if (authMarkerPath()) fs.writeFileSync(authMarkerPath(), methodId);
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/load') {
    sessionId = String((msg.params || {}).sessionId || '');
    send({ jsonrpc: '2.0', id: msg.id, result: { modes: {}, models: {} } });
    return;
  }
  if (msg.method === 'session/prompt') {
    sessionId = String((msg.params || {}).sessionId || '');
    const promptText = String((((msg.params || {}).prompt || [])[0] || {}).text || '');
    const replyId = msg.id;
    // 增量第一步：user + assistant(tool_use) 立即落库 —— 旧实现会在这一步收尾。
    const doc = readDoc();
    doc.messages.push({ role: 'user', content: [{ type: 'text', text: promptText }], ts: Date.now() });
    doc.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'call_acp_1', name: 'run_commands',
      input: { commands: ['echo hi'] } }], ts: Date.now() });
    writeDoc(doc);
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'tool_call', toolCallId: 'call_acp_1', title: 'run_commands: echo hi',
      kind: 'execute', status: 'pending' } } });
    setTimeout(() => {
      // 增量第二步：tool_result + 最终 assistant 文本；随后才回 prompt 响应（整轮结束）。
      const second = readDoc();
      second.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_acp_1',
        name: 'run_commands', content: [{ query: 'echo hi', result: 'hi\n' }] }], ts: Date.now() });
      second.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'FINAL:' + promptText }], ts: Date.now() });
      writeDoc(second);
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FINAL:' + promptText } } } });
      send({ jsonrpc: '2.0', id: replyId, result: { stopReason: 'end_turn' } });
    }, 400);
  }
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let index;
  while ((index = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, index).trim();
    buf = buf.slice(index + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (_error) {}
  }
});
process.stdin.on('end', () => process.exit(0));
// 逃生：引擎若没杀掉（实现回归），自己退，避免测试进程悬挂。
setTimeout(() => process.exit(9), 15000);
`;

function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cline-acp-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, 'aih');
  const hostHomeDir = path.join(root, 'home');
  const projectPath = path.join(root, 'project');
  fs.mkdirSync(hostHomeDir, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'cline',
    identitySeed: 'cline-acp-engine-user'
  });
  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, 'cline', accountRef);
  if (options.seedClinePass !== false) {
    // 账号库凭据（cline-pass 槽位）：物化进投影后，resolveAcpAuthMethod 从投影文档推导
    // authenticate 方法（与真实链路同一条物化路径）。
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
      auth: providersDocument('cline-pass', clineAuth('acp-user', 1))
    });
  } else if (options.seedClineSlot) {
    // 只有默认 `cline` 槽位（API Key / Credits 通道）：投影成立、但不该推导出 cline-pass。
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
      auth: providersDocument('cline', clineAuth('acp-user', 1))
    });
  }
  // resume 目标：一段旧会话（历史 user 消息 = beforeMessages 基线）。
  const sessionDir = path.join(runtimeDir, '.cline', 'data', 'sessions', SESSION_ID);
  fs.mkdirSync(sessionDir, { recursive: true });
  const messagesPath = path.join(sessionDir, `${SESSION_ID}.messages.json`);
  fs.writeFileSync(messagesPath, JSON.stringify({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'earlier question' }], ts: Date.now() - 60000 }
  ] }));
  const fixture = path.join(root, 'fake-cline-acp.cjs');
  fs.writeFileSync(fixture, FIXTURE_SOURCE);
  const authMarker = path.join(root, 'acp-auth-method.txt');
  const events = [];
  const spawnOptions = {
    provider: 'cline',
    accountRef,
    aiHomeDir,
    hostHomeDir,
    projectPath,
    interactiveCli: false,
    getProfileDir: () => runtimeDir,
    resolveNativeCliLaunch: () => ({ command: process.execPath, prefixArgs: [fixture] }),
    ensureSessionStoreLinks: () => ({ migrated: 0, linked: 0, unresolved: [] }),
    env: {
      ...process.env,
      HOME: hostHomeDir,
      AIH_HOST_HOME: hostHomeDir,
      FAKE_CLINE_MESSAGES_PATH: messagesPath,
      FAKE_CLINE_AUTH_MARKER: authMarker
    },
    onEvent: (event) => events.push(event)
  };
  return { spawnOptions, events, messagesPath, authMarker };
}

test('cline ACP resume completes only after the prompt settles (tool turns keep the final answer)', { timeout: 20000 }, async (t) => {
  const { spawnOptions, events } = createFixture(t);
  const run = spawnNativeSessionStream({ ...spawnOptions, sessionId: SESSION_ID, prompt: 'hello' });
  const result = await run.done;

  assert.equal(result.sessionId, SESSION_ID);
  // 收尾必须发生在 prompt 结算之后：最终文本在第二步才落库，只有等 stopReason
  // 才能读到它（旧实现会在第一步的 tool_use 追加时收尾，这里只会剩 :::tool 块）。
  assert.match(result.content, /FINAL:hello/);
  assert.match(result.content, /:::tool\{name="run_commands"\}/);
  const last = result.afterMessages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.match(JSON.stringify(last.content), /FINAL:hello/);
  assert.ok(events.some((event) => event.type === 'assistant_tool_call'), 'ACP 轮次应产出工具事件');
  assert.ok(events.some((event) => event.type === 'delta' && String(event.delta || '').includes('FINAL:')),
    'ACP 轮次应流式送出最终文本 delta');
});

test('cline ACP resume authenticates through the slot derived from the projection', { timeout: 20000 }, async (t) => {
  const withSlot = createFixture(t);
  await spawnNativeSessionStream({ ...withSlot.spawnOptions, sessionId: SESSION_ID, prompt: 'hi' }).done;
  assert.equal(fs.readFileSync(withSlot.authMarker, 'utf8'), 'cline-pass',
    '有 cline-pass 投影凭据时 authenticate 必须走 cline-pass 槽位');

  const withoutSlot = createFixture(t, { seedClinePass: false, seedClineSlot: true });
  await spawnNativeSessionStream({ ...withoutSlot.spawnOptions, sessionId: SESSION_ID, prompt: 'hi' }).done;
  assert.equal(fs.existsSync(withoutSlot.authMarker), false,
    '只有默认 cline 槽位凭据时不调 authenticate（与 CLI 默认槽位对齐）');
});
