'use strict';

// 测试用的最小 ACP agent（等价于 `cline --acp` 的协议面）：NDJSON/JSON-RPC over stdio。
// 只实现 E2E 需要的形状：initialize / authenticate / session/load / session/new /
// session/prompt / session/request_permission，并在 prompt 结算前把最终答复写入
// FAKE_CLINE_TRANSCRIPT 指定的文件，供引擎级测试断言 transcript 落库。

const fs = require('node:fs');
const readline = require('node:readline');

const transcriptPath = process.env.FAKE_CLINE_TRANSCRIPT || '';
const authFail = process.env.FAKE_CLINE_AUTH_FAIL === '1';
const rl = readline.createInterface({ input: process.stdin });
let permissionWaiter = null;
let permissionId = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function writeTranscript(text) {
  if (!transcriptPath) return;
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ role: 'assistant', content: text })}\n`);
}

rl.on('line', (line) => {
  let message = null;
  try {
    message = JSON.parse(line);
  } catch (_error) {
    return;
  }
  if (!message || typeof message !== 'object') return;

  // agent→client 请求（session/request_permission）的响应。
  if (message.id !== undefined && message.method === undefined) {
    if (permissionWaiter && message.id === permissionId) {
      const waiter = permissionWaiter;
      permissionWaiter = null;
      waiter(message.result);
    }
    return;
  }

  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    respond(id, { protocolVersion: 1 });
    return;
  }
  if (method === 'authenticate') {
    if (authFail) {
      respondError(id, 'bad credentials');
      return;
    }
    respond(id, {});
    return;
  }
  if (method === 'session/load') {
    respond(id, { models: { availableModels: [] } });
    return;
  }
  if (method === 'session/new') {
    respond(id, {
      sessionId: 'fake-new-session',
      models: { availableModels: [] },
      modes: { availableModes: [] }
    });
    return;
  }
  if (method === 'session/set_mode' || method === 'session/set_model') {
    respond(id, {});
    return;
  }
  if (method === 'session/prompt') {
    notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking' }
      }
    });
    notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        title: 'read_file',
        kind: 'read'
      }
    });
    permissionId = 100;
    send({
      jsonrpc: '2.0',
      id: permissionId,
      method: 'session/request_permission',
      params: {
        sessionId: params.sessionId,
        toolCall: {
          kind: 'execute',
          title: 'echo ok',
          rawInput: { command: 'echo ok' }
        },
        options: [
          { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
        ]
      }
    });
    permissionWaiter = (result) => {
      const outcome = result && result.outcome && result.outcome.outcome;
      notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'final answer' }
        }
      });
      writeTranscript('final answer');
      respond(id, { stopReason: outcome === 'selected' ? 'end_turn' : 'cancelled' });
    };
    return;
  }
  if (id !== undefined) respondError(id, `method not supported: ${method}`);
});
