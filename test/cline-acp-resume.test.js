'use strict';

// cline ACP 续聊的真实子进程 E2E：起一个独立的 ACP agent 进程（fake-cline-acp），
// 走完整 NDJSON/JSON-RPC 握手与 session/prompt，验证流式 delta、工具事件、
// 权限往返和 transcript 落库。协议层纯函数测试见 acp-session-runner.test.js。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createAcpSessionChild,
  startAcpSessionTurn
} = require('../lib/server/acp-session-runner');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-cline-acp.js');

function createFixture(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cline-acp-'));
  const transcript = path.join(root, 'transcript.jsonl');
  const launched = createAcpSessionChild({
    command: process.execPath,
    args: [FIXTURE],
    cwd: root,
    env: { ...process.env, FAKE_CLINE_TRANSCRIPT: transcript, ...extraEnv }
  });
  return { root, transcript, ...launched };
}

test('cline ACP resume：真实子进程完成握手、流式 delta、工具事件、权限与转录', async () => {
  const { root, transcript, child, client } = createFixture();
  const events = [];
  const failures = [];
  let savedTranscript = '';
  try {
    await startAcpSessionTurn(client, {
      sessionId: 'session-resume-1',
      prompt: 'continue the task',
      authMethod: 'cline',
      approvalMode: 'bypass',
      emitEvent: (event) => events.push(event),
      onFatal: (error) => failures.push(error)
    });
    savedTranscript = fs.readFileSync(transcript, 'utf8');
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.deepEqual(failures, []);
  assert.deepEqual(events, [
    { type: 'thinking', thinking: 'thinking' },
    { type: 'assistant_tool_call', content: 'read_file' },
    { type: 'delta', delta: 'final answer' }
  ]);
  // transcript 在 prompt 结算前落盘，E2E 必须能看到最终答复。
  const lines = savedTranscript.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines, [{ role: 'assistant', content: 'final answer' }]);
});

test('cline ACP resume：认证失败走 onFatal，不产生 transcript', async () => {
  const { root, transcript, child, client } = createFixture({ FAKE_CLINE_AUTH_FAIL: '1' });
  const failures = [];
  try {
    await startAcpSessionTurn(client, {
      sessionId: 'session-resume-2',
      prompt: 'continue',
      authMethod: 'cline',
      approvalMode: 'bypass',
      onFatal: (error) => failures.push(error)
    });
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'acp_request_failed');
  assert.match(String(failures[0].acpError?.message || ''), /bad credentials/);
  assert.equal(fs.existsSync(transcript), false);
});
