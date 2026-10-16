'use strict';

// ACP 假 agent 夹具：按 ACP_FAKE_SCENARIO 演一段脚本化的 ACP 会话，用于
// acp-session-runner 的协议级单测（真实 spawn + NDJSON 往返，不 mock 流）。
//
// 场景：
//   happy      initialize/authenticate/load（带回放）→ prompt 流式 delta → end_turn
//   permission prompt 期间发 session/request_permission（id 0，实测形状）→ 按回执收尾
//   authfail   authenticate 返回 error（验证 onFatal 与错误码）
//   crash      session/load 时直接退出（验证进程死亡 → 请求 reject + onExit）

const scenario = process.env.ACP_FAKE_SCENARIO || 'happy';
let buf = '';
let sessionId = '';
let pendingPromptId = null;
let authenticatedMethod = '';

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sendUpdate = (update) => send({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId, update }
});

const handle = (msg) => {
  if (typeof msg.method === 'string') {
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [
            { id: 'cline', name: 'Sign in with Cline' },
            { id: 'cline-pass', name: 'Sign in with ClinePass' }
          ]
        }
      });
      return;
    }
    if (msg.method === 'authenticate') {
      if (scenario === 'authfail') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: 401, message: 'no credentials' } });
        return;
      }
      authenticatedMethod = String((msg.params || {}).methodId || '');
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    if (msg.method === 'session/load') {
      sessionId = String((msg.params || {}).sessionId || '');
      if (scenario === 'crash') {
        process.exit(7);
      }
      // 回放：在 load 响应【之前】发出（与真实 cline 一致），消费方必须丢弃。
      sendUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replay user' } });
      sendUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replay agent' } });
      send({ jsonrpc: '2.0', id: msg.id, result: { modes: {}, models: {} } });
      return;
    }
    if (msg.method === 'session/prompt') {
      sessionId = String((msg.params || {}).sessionId || '');
      pendingPromptId = msg.id;
      if (scenario === 'permission') {
        sendUpdate({
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'run_commands: echo hi',
          kind: 'execute',
          status: 'pending'
        });
        send({
          jsonrpc: '2.0',
          id: 0,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { toolCallId: 't1' },
            options: [
              { optionId: 'opt-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'opt-always', name: 'Always allow', kind: 'allow_always' }
            ]
          }
        });
        return;
      }
      sendUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `auth=${authenticatedMethod};` }
      });
      sendUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hel' } });
      sendUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } });
      send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'end_turn' } });
      pendingPromptId = null;
      return;
    }
    return;
  }
  // 权限回执（id 0）或其它响应。
  if (scenario === 'permission' && pendingPromptId !== null) {
    const outcome = msg.result && msg.result.outcome;
    const selected = outcome && outcome.outcome === 'selected';
    sendUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      rawOutput: 'hi'
    });
    sendUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: selected ? `allowed:${outcome.optionId}` : 'denied' }
    });
    send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'end_turn' } });
    pendingPromptId = null;
  }
};

process.stderr.write('[acp-fake] boot\n');
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let index;
  while ((index = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, index).trim();
    buf = buf.slice(index + 1);
    if (!line) continue;
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch (_error) {
      continue;
    }
    handle(msg);
  }
});
