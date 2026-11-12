'use strict';

// ACP adapter 的协议层守卫：不启真实子进程、不碰网络。
// stdio 用假 spawn（EventEmitter + PassThrough），HTTP 用注入的假通道 ——
// 两者共用同一个协议核，所以「同一套映射、只换传输」在这里被直接验证。

const test = require('node:test');
const assert = require('node:assert/strict');

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAdapter: createStdioAdapter } = require('../lib/agent-session/adapters/acp-stdio');
const {
  MISSING_EVIDENCE,
  createAdapter: createHttpAdapter
} = require('../lib/agent-session/adapters/acp-http-sse');
const { startAgentSession } = require('../lib/agent-session/facade');

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function until(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * 假 ACP agent：读 stdin 的 NDJSON 帧，按注册的方法回响应；也能主动发通知/请求。
 * 请求 id 用 100+，与 client 的 1..n 分开，模拟真实协议里两边 id 空间独立。
 */
function createFakeAgent() {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = () => {
    if (proc.killed) return;
    proc.killed = true;
    proc.exitCode = 0;
    proc.emit('exit', 0, 'SIGTERM');
  };

  const frames = [];
  const handlers = new Map();
  const outbound = new Map();
  let buffer = '';
  let nextOutboundId = 100;

  function write(message) {
    proc.stdout.write(`${JSON.stringify(message)}\n`);
  }

  proc.stdin.on('data', (chunk) => {
    buffer += String(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      frames.push(frame);
      if (typeof frame.method === 'string' && frame.id !== undefined && frame.id !== null) {
        const handler = handlers.get(frame.method);
        if (!handler) {
          write({ jsonrpc: '2.0', id: frame.id, result: {} });
          continue;
        }
        Promise.resolve()
          .then(() => handler(frame.params || {}, frame))
          .then(
            (result) => write({ jsonrpc: '2.0', id: frame.id, result: result === undefined ? {} : result }),
            (error) => write({
              jsonrpc: '2.0',
              id: frame.id,
              error: { code: -32000, message: String((error && error.message) || error) }
            })
          );
        continue;
      }
      if (typeof frame.method === 'string') {
        const handler = handlers.get(frame.method);
        if (handler) Promise.resolve().then(() => handler(frame.params || {}, frame)).catch(() => {});
        continue;
      }
      if (frame.id !== undefined && frame.id !== null) {
        const waiter = outbound.get(frame.id);
        if (waiter) {
          outbound.delete(frame.id);
          waiter(frame);
        }
      }
    }
  });

  return {
    proc,
    frames,
    handle(method, handler) {
      handlers.set(method, handler);
    },
    notify(method, params) {
      write({ jsonrpc: '2.0', method, params });
    },
    request(method, params) {
      nextOutboundId += 1;
      const id = nextOutboundId;
      const promise = new Promise((resolve) => outbound.set(id, resolve));
      write({ jsonrpc: '2.0', id, method, params });
      return promise;
    },
    methods() {
      return frames
        .filter((frame) => typeof frame.method === 'string' && frame.id !== undefined)
        .map((frame) => frame.method);
    }
  };
}

function stdioAdapter(provider, context, sessionId = 's1') {
  return createStdioAdapter({
    sessionId,
    provider,
    transport: 'acp-stdio',
    context
  });
}

test('acp-stdio: open(newSession) 走 initialize → session/new，模型/模式归一化', async () => {
  const agent = createFakeAgent();
  const spawned = [];
  agent.handle('initialize', () => ({ protocolVersion: 1 }));
  agent.handle('session/new', () => ({
    sessionId: 'acp-1',
    models: { currentModelId: 'm1', availableModels: [{ modelId: 'm1', name: 'Model 1' }] },
    modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] }
  }));
  const adapter = stdioAdapter('gemini', {
    spawn(command, args, options) {
      spawned.push({ command, args, options });
      return agent.proc;
    }
  });

  const result = await adapter.open({ newSession: true, cwd: '/tmp/project' });

  assert.deepEqual(result, {
    sessionId: 'acp-1',
    models: [{ id: 'm1', name: 'Model 1' }],
    modes: [{ id: 'default', name: 'Default' }]
  });
  assert.deepEqual(agent.methods(), ['initialize', 'session/new']);
  // 入口参数只来自布局表：gemini 是 --acp，二进制名 gemini。
  assert.equal(spawned[0].command, 'gemini');
  assert.deepEqual(spawned[0].args, ['--acp']);
  assert.equal(spawned[0].options.cwd, '/tmp/project');
  assert.deepEqual(agent.frames[1].params, { cwd: '/tmp/project', mcpServers: [] });
  adapter.dispose('test');
});

test('acp-stdio: fs/* 请求由客户端落盘（gemini 的 write_file 依赖它）', async () => {
  const agent = createFakeAgent();
  agent.handle('initialize', () => ({}));
  agent.handle('session/new', () => ({ sessionId: 'acp-1' }));
  const adapter = stdioAdapter('gemini', { spawn: () => agent.proc });
  await adapter.open({ newSession: true, cwd: '/tmp' });

  // 2026-11-03 实机：声明 false 时 gemini 的 write_file 在审批通过后仍然 failed，
  // 文件根本没创建。客户端必须自己声明并实现这两个方法。
  const init = agent.frames.find((frame) => frame.method === 'initialize');
  assert.deepEqual(init.params.clientCapabilities.fs, { readTextFile: true, writeTextFile: true });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-fs-'));
  const file = path.join(dir, 'nested', 'hello.txt');
  const write = await agent.request('fs/write_text_file', { path: file, content: 'hi from agent' });
  assert.deepEqual(write.result, {});
  assert.equal(fs.readFileSync(file, 'utf8'), 'hi from agent');

  const read = await agent.request('fs/read_text_file', { path: file });
  assert.equal(read.result.content, 'hi from agent');

  const missing = await agent.request('fs/read_text_file', { path: path.join(dir, 'nope.txt') });
  assert.ok(missing.error, '读不到的文件必须回错误，不能回空内容');
  adapter.dispose('test');
});

test('acp-stdio: session/load 的重放不产生事件，映射在 load 之后才生效', async () => {
  const agent = createFakeAgent();
  agent.handle('initialize', () => ({}));
  agent.handle('session/load', () => {
    // load 响应前的 update 是历史回放：此时映射还没激活，必须被丢弃。
    agent.notify('session/update', {
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replay' } }
    });
    return {};
  });
  const adapter = stdioAdapter('cline', { spawn: () => agent.proc, acpSessionId: 'acp-2' }, 's2');
  const events = [];
  adapter.subscribe((event) => events.push(event));

  await adapter.open({ cwd: '/tmp/work' });

  assert.deepEqual(events, []);
  assert.deepEqual(agent.methods(), ['initialize', 'session/load']);
  assert.equal(agent.frames[1].params.sessionId, 'acp-2');
  assert.equal(agent.frames[1].params.cwd, '/tmp/work');

  agent.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } }
  });
  await until(() => events.length >= 2, 'message events');

  assert.equal(events[0].type, 'timeline.item.started');
  assert.equal(events[0].payload.item.kind, 'message');
  assert.equal(events[1].type, 'timeline.item.delta');
  assert.equal(events[1].payload.chunk, 'hello');
  assert.equal(events[1].payload.kind, 'message');
  adapter.dispose('test');
});

test('acp-stdio: prompt 返回 stopReason，session/update 映射成 canonical 事件', async () => {
  const agent = createFakeAgent();
  agent.handle('initialize', () => ({}));
  agent.handle('session/new', () => ({ sessionId: 'acp-3' }));
  agent.handle('session/prompt', () => {
    agent.notify('session/update', {
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } }
    });
    agent.notify('session/update', {
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }
    });
    agent.notify('session/update', {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'read_file',
        kind: 'read',
        status: 'in_progress',
        rawInput: { path: 'a.js' }
      }
    });
    agent.notify('session/update', {
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: 'ok' }
    });
    agent.notify('session/update', {
      update: { sessionUpdate: 'plan', entries: [{ content: 'step 1', status: 'completed', priority: 'high' }] }
    });
    return { stopReason: 'end_turn' };
  });
  const adapter = stdioAdapter('codebuddy', { spawn: () => agent.proc });
  const events = [];
  adapter.subscribe((event) => events.push(event));

  await adapter.open({ newSession: true });
  const result = await adapter.prompt({ text: 'go', turnId: 't1' });

  assert.deepEqual(result, { stopReason: 'end_turn' });
  assert.equal(agent.frames[2].params.prompt[0].text, 'go');

  const reasoning = events.find((event) => event.type === 'timeline.item.delta' && event.payload.kind === 'reasoning');
  assert.equal(reasoning.payload.chunk, 'think');
  assert.equal(reasoning.turnId, 't1');

  const message = events.find((event) => event.type === 'timeline.item.delta' && event.payload.kind === 'message');
  assert.equal(message.payload.chunk, 'hi');

  const toolStarted = events.find((event) => event.type === 'timeline.item.started' && event.payload.item.kind === 'tool');
  assert.equal(toolStarted.payload.item.status, 'running');
  assert.equal(toolStarted.payload.item.content, 'read_file');

  const toolUpdated = events.find((event) => event.type === 'timeline.item.updated' && event.payload.item.kind === 'tool');
  assert.equal(toolUpdated.payload.item.status, 'completed');

  const plan = events.find((event) => event.type === 'timeline.item.updated' && event.payload.item.kind === 'plan');
  assert.deepEqual(plan.payload.item.detail.steps, [{ step: 'step 1', status: 'completed', priority: 'high' }]);

  // 轮次收尾补齐 completed，时间线不会停在 running。
  const completed = events.filter((event) => event.type === 'timeline.item.completed');
  assert.deepEqual(completed.map((event) => event.payload.item.kind).sort(), ['message', 'reasoning']);
  assert.ok(completed.every((event) => event.payload.item.status === 'completed'));
  adapter.dispose('test');
});

test('acp-stdio: permission → approval 交互请求，respond 回写选中的 optionId', async () => {
  const agent = createFakeAgent();
  let permissionResponse = null;
  agent.handle('initialize', () => ({}));
  agent.handle('session/new', () => ({ sessionId: 'acp-4' }));
  agent.handle('session/prompt', async () => {
    permissionResponse = await agent.request('session/request_permission', {
      sessionId: 'acp-4',
      toolCall: {
        toolCallId: 'c9',
        kind: 'execute',
        title: 'rm -rf build',
        rawInput: { command: 'rm -rf build' }
      },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ]
    });
    return { stopReason: 'end_turn' };
  });
  const adapter = stdioAdapter('qoder', { spawn: () => agent.proc });
  const requests = [];
  adapter.onInteractionRequest((request) => requests.push(request));

  await adapter.open({ newSession: true });
  const promptPromise = adapter.prompt({ text: 'run', turnId: 't1' });
  await until(() => requests.length === 1, 'permission request');

  const request = requests[0];
  assert.equal(request.kind, 'approval');
  assert.match(request.payload.presentation.title, /rm -rf build/);
  assert.deepEqual(
    request.payload.choices.map((choice) => [choice.id, choice.intent]),
    [['allow-once', 'accept'], ['reject-once', 'deny']]
  );
  assert.equal(request.turnId, 't1');
  assert.equal(request.itemId, 'acp-tool-c9');

  // 未知 optionId 必须被拒，且不能写回 agent。
  assert.throws(
    () => adapter.respond(request.interactionId, { choiceId: 'nope' }),
    (error) => error.code === 'acp_decision_choice_unknown'
  );
  assert.equal(permissionResponse, null);

  const written = adapter.respond(request.interactionId, { choiceId: 'allow-once' });
  assert.deepEqual(written, { interactionId: request.interactionId, optionId: 'allow-once' });

  assert.deepEqual(await promptPromise, { stopReason: 'end_turn' });
  assert.equal(permissionResponse.result.outcome.outcome, 'selected');
  assert.equal(permissionResponse.result.outcome.optionId, 'allow-once');
  adapter.dispose('test');
});

test('acp-stdio: 没有交互 handler 时 fail closed，回 cancelled 并报 stream.error', async () => {
  const agent = createFakeAgent();
  let permissionResponse = null;
  agent.handle('initialize', () => ({}));
  agent.handle('session/new', () => ({ sessionId: 'acp-5' }));
  agent.handle('session/prompt', async () => {
    permissionResponse = await agent.request('session/request_permission', {
      toolCall: { kind: 'execute', title: 'touch x' },
      options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
    });
    return { stopReason: 'end_turn' };
  });
  const adapter = stdioAdapter('gemini', { spawn: () => agent.proc });
  const errors = [];
  adapter.subscribe((event) => {
    if (event.type === 'stream.error') errors.push(event);
  });

  await adapter.open({ newSession: true });
  const result = await adapter.prompt({ text: 'run' });

  assert.deepEqual(result, { stopReason: 'end_turn' });
  assert.equal(permissionResponse.result.outcome.outcome, 'cancelled');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].payload.code, 'acp_interaction_handler_unavailable');
  adapter.dispose('test');
});

test('acp-stdio: 子进程退出 → stream.error，在飞 prompt 被拒', async () => {
  const agent = createFakeAgent();
  agent.handle('initialize', () => ({}));
  agent.handle('session/new', () => ({ sessionId: 'acp-6' }));
  agent.handle('session/prompt', () => new Promise(() => {}));
  const adapter = stdioAdapter('gemini', { spawn: () => agent.proc });
  const errors = [];
  adapter.subscribe((event) => {
    if (event.type === 'stream.error') errors.push(event);
  });

  await adapter.open({ newSession: true });
  const pending = adapter.prompt({ text: 'hang', turnId: 't1' });
  await until(() => agent.frames.some((frame) => frame.method === 'session/prompt'), 'prompt frame');

  agent.proc.exitCode = 1;
  agent.proc.emit('exit', 1, null);

  await assert.rejects(pending, (error) => error.code === 'acp_process_exited');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].payload.code, 'acp_process_exited');
  assert.equal(errors[0].payload.exitCode, 1);
});

test('acp-stdio: dispose 杀掉子进程并拒绝在飞请求，不再发 stream.error', async () => {
  const agent = createFakeAgent();
  agent.handle('initialize', () => ({}));
  agent.handle('session/new', () => ({ sessionId: 'acp-7' }));
  agent.handle('session/prompt', () => new Promise(() => {}));
  const adapter = stdioAdapter('gemini', { spawn: () => agent.proc });
  const errors = [];
  adapter.subscribe((event) => {
    if (event.type === 'stream.error') errors.push(event);
  });

  await adapter.open({ newSession: true });
  const pending = adapter.prompt({ text: 'hang' });
  await until(() => agent.frames.some((frame) => frame.method === 'session/prompt'), 'prompt frame');

  adapter.dispose('done');

  await assert.rejects(pending, (error) => error.code === 'acp_session_disposed');
  assert.equal(agent.proc.killed, true);
  assert.deepEqual(errors, []);
});

test('acp-stdio: provider 没有 ACP 布局时直接拒绝，不 spawn', async () => {
  const adapter = stdioAdapter('agy', {});
  await assert.rejects(
    () => adapter.open({}),
    (error) => error.code === 'acp_entry_unsupported'
  );
});

test('acp-stdio: 未声明的模式被拒，声明过的模式走 session/set_mode', async () => {
  const agent = createFakeAgent();
  agent.handle('initialize', () => ({}));
  agent.handle('session/new', () => ({
    sessionId: 'acp-8',
    modes: { availableModes: [{ id: 'plan' }, { id: 'default' }] }
  }));
  agent.handle('session/set_mode', () => ({}));
  const adapter = stdioAdapter('gemini', { spawn: () => agent.proc });

  await adapter.open({ newSession: true, mode: 'plan' });
  assert.deepEqual(agent.methods(), ['initialize', 'session/new', 'session/set_mode']);
  assert.deepEqual(agent.frames[2].params, { sessionId: 'acp-8', modeId: 'plan' });
  adapter.dispose('test');

  const strictAgent = createFakeAgent();
  strictAgent.handle('initialize', () => ({}));
  strictAgent.handle('session/new', () => ({ sessionId: 'acp-9', modes: { availableModes: [{ id: 'default' }] } }));
  const strict = stdioAdapter('gemini', { spawn: () => strictAgent.proc }, 's9');
  await assert.rejects(
    () => strict.open({ newSession: true, mode: 'yolo' }),
    (error) => error.code === 'acp_mode_unsupported'
  );
  assert.deepEqual(strictAgent.methods(), ['initialize', 'session/new']);
});

test('acp-stdio: cancel 发 session/cancel 通知，并把挂起的审批回 cancelled', async () => {
  const agent = createFakeAgent();
  agent.handle('initialize', () => ({}));
  agent.handle('session/new', () => ({ sessionId: 'acp-c' }));
  let permissionResponse = null;
  agent.handle('session/prompt', async () => {
    permissionResponse = await agent.request('session/request_permission', {
      toolCall: { kind: 'execute', title: 'sleep 100' },
      options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
    });
    return { stopReason: 'cancelled' };
  });
  const adapter = stdioAdapter('gemini', { spawn: () => agent.proc });
  const requests = [];
  adapter.onInteractionRequest((request) => requests.push(request));

  await adapter.open({ newSession: true });
  const promptPromise = adapter.prompt({ text: 'run', turnId: 't1' });
  await until(() => requests.length === 1, 'permission request');

  assert.deepEqual(await adapter.cancel('user'), { cancelled: true, reason: 'user' });
  const cancelFrame = agent.frames.find((frame) => frame.method === 'session/cancel');
  assert.equal(cancelFrame.id, undefined);
  assert.deepEqual(cancelFrame.params, { sessionId: 'acp-c' });

  assert.deepEqual(await promptPromise, { stopReason: 'cancelled' });
  assert.equal(permissionResponse.result.outcome.outcome, 'cancelled');
  // 已经按 cancelled 结束的交互不能再被回答。
  assert.throws(
    () => adapter.respond(requests[0].interactionId, { choiceId: 'allow-once' }),
    (error) => error.code === 'acp_interaction_unknown'
  );
  adapter.dispose('test');
});

test('acp-http-sse: 没有可靠端点发现时 fail closed', async () => {
  const adapter = createHttpAdapter({
    sessionId: 's10',
    provider: 'codebuddy',
    transport: 'acp-http-sse',
    context: {}
  });
  await assert.rejects(
    () => adapter.open({ newSession: true }),
    (error) => error.code === 'acp_http_endpoint_unavailable'
      && Array.isArray(error.details.missing)
      && error.details.missing.length === MISSING_EVIDENCE.length
  );
});

test('acp-http-sse: 注入通道后复用同一套握手/事件映射', async () => {
  const sent = [];
  const messageHandlers = new Set();
  const closeHandlers = new Set();
  const channel = {
    send(message) {
      sent.push(message);
      return true;
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close() {
      for (const handler of Array.from(closeHandlers)) {
        handler({ code: 'acp_http_closed', message: 'closed' });
      }
    }
  };
  function emit(message) {
    for (const handler of Array.from(messageHandlers)) handler(message);
  }
  const adapter = createHttpAdapter({
    sessionId: 's11',
    provider: 'codebuddy',
    transport: 'acp-http-sse',
    context: { acpHttpChannel: channel }
  });
  const events = [];
  adapter.subscribe((event) => events.push(event));

  const openPromise = adapter.open({ newSession: true });
  await until(() => sent.some((frame) => frame.method === 'initialize'), 'initialize');
  const initialize = sent.find((frame) => frame.method === 'initialize');
  emit({ jsonrpc: '2.0', id: initialize.id, result: { protocolVersion: 1 } });

  await until(() => sent.some((frame) => frame.method === 'session/new'), 'session/new');
  const create = sent.find((frame) => frame.method === 'session/new');
  emit({ jsonrpc: '2.0', id: create.id, result: { sessionId: 'http-1' } });

  assert.deepEqual(await openPromise, { sessionId: 'http-1', models: [], modes: [] });

  const promptPromise = adapter.prompt({ text: 'hi', turnId: 't1' });
  await until(() => sent.some((frame) => frame.method === 'session/prompt'), 'session/prompt');
  const prompt = sent.find((frame) => frame.method === 'session/prompt');
  emit({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hey' } } }
  });
  emit({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });

  assert.deepEqual(await promptPromise, { stopReason: 'end_turn' });
  const delta = events.find((event) => event.type === 'timeline.item.delta');
  assert.equal(delta.payload.chunk, 'hey');
  assert.equal(delta.payload.kind, 'message');
  adapter.dispose('test');
});

test('facade + shell: ACP adapter 在会话外壳里完成一次审批往返', async () => {
  const agent = createFakeAgent();
  agent.handle('initialize', () => ({}));
  agent.handle('session/new', () => ({ sessionId: 'acp-e2e' }));
  let permissionResponse = null;
  agent.handle('session/prompt', async () => {
    permissionResponse = await agent.request('session/request_permission', {
      toolCall: { kind: 'execute', title: 'npm test' },
      options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
    });
    return { stopReason: 'end_turn' };
  });
  const { session, adapterId } = startAgentSession({
    sessionId: 'e2e',
    provider: 'gemini',
    context: { spawn: () => agent.proc }
  });
  assert.equal(adapterId, 'acp-stdio');

  await session.open({ newSession: true });
  const types = [];
  session.subscribe((event) => types.push(event.type));

  const promptPromise = session.prompt({ text: 'run' });
  await until(() => session.router.pendingCount() === 1, 'pending interaction');
  const [pending] = session.router.pending();
  const resolved = session.respond(pending.interactionId, { choiceId: 'allow-once' });
  assert.equal(resolved.state, 'resolved');

  const result = await promptPromise;
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(permissionResponse.result.outcome.optionId, 'allow-once');
  assert.deepEqual(
    types.filter((type) => ['turn.started', 'interaction.requested', 'interaction.resolved', 'turn.completed'].includes(type)),
    ['turn.started', 'interaction.requested', 'interaction.resolved', 'turn.completed']
  );
  session.dispose('done');
});
