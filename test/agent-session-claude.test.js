'use strict';

// Claude adapter：用假子进程 + 真 loopback 桥验证「工具调用 → 契约交互 → 决策回写」。
// 桥是真的（127.0.0.1、端口由内核分配），所以 token、长轮询、超时都是真路径；
// 只有 claude 进程是假的，测试因此不依赖本机装没装 claude。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const { startAgentSession } = require('../lib/agent-session/facade');

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      child.stdin.writes.push(String(chunk));
      callback();
    }
  });
  child.stdin.writes = [];
  child.killed = [];
  child.kill = (signal) => {
    child.killed.push(signal || 'SIGTERM');
    return true;
  };
  child.emitLine = (event) => child.stdout.write(`${JSON.stringify(event)}\n`);
  return child;
}

function setup(options = {}) {
  const child = createFakeChild();
  const captured = { launchContext: null, removed: null };
  const spawns = [];
  const context = Object.assign({
    spawn: (command, args, spawnOptions) => {
      spawns.push({ command, args, spawnOptions });
      setImmediate(() => child.emitLine({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-real',
        model: 'claude-sonnet'
      }));
      return child;
    },
    writeLaunchContext: (fields) => {
      captured.launchContext = fields;
      return '/tmp/aih-fake-launch-context.json';
    },
    removeLaunchContext: (file) => {
      captured.removed = file;
      return true;
    },
    permissionToolPath: '/tmp/aih/claude-permission-mcp-tool.js',
    approvalTimeoutMs: options.approvalTimeoutMs || 2000
  }, options.context || {});
  const started = startAgentSession({
    sessionId: 's1',
    provider: 'claude',
    context,
    interactionTimeoutMs: options.interactionTimeoutMs
  });
  return Object.assign({ child, captured, spawns, context }, started);
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_error) { parsed = null; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function firstPending(session) {
  return session.router.pending()[0] || null;
}

test('open：桥只监听 127.0.0.1，参数由 claudeApprovalArgs/buildClaudeApprovalMcpConfig 生成', async () => {
  const { session, captured, spawns } = setup();
  const opened = await session.open({ mode: 'plan', cwd: '/tmp/work', model: 'claude-sonnet' });
  assert.equal(opened.sessionId, 'sess-real');
  assert.ok(opened.modes.some((mode) => mode.id === 'plan'));

  const url = new URL(captured.launchContext.approvalUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/approve\/[0-9a-f]{48}$/);
  assert.equal(captured.launchContext.runId, 's1');

  const spawn = spawns[0];
  assert.equal(spawn.spawnOptions.cwd, '/tmp/work');
  assert.ok(spawn.args.includes('--print'));
  assert.ok(spawn.args.includes('--input-format'));
  assert.deepEqual(
    spawn.args.slice(spawn.args.indexOf('--permission-mode'), spawn.args.indexOf('--permission-mode') + 2),
    ['--permission-mode', 'plan']
  );
  assert.ok(spawn.args.includes('--permission-prompt-tool'));
  assert.equal(spawn.args[spawn.args.indexOf('--permission-prompt-tool') + 1], 'mcp__aih__approve');

  const mcpConfig = JSON.parse(spawn.args[spawn.args.indexOf('--mcp-config') + 1]);
  assert.equal(mcpConfig.mcpServers.aih.args[0], '/tmp/aih/claude-permission-mcp-tool.js');
  assert.equal(
    mcpConfig.mcpServers.aih.env.AIH_LAUNCH_CONTEXT,
    '/tmp/aih-fake-launch-context.json'
  );

  session.dispose('done');
  assert.equal(captured.removed, '/tmp/aih-fake-launch-context.json');
});

test('approval：桥收到工具调用 → approval 交互，respond 解开长轮询', async () => {
  const { session, captured } = setup();
  await session.open({ mode: 'confirm' });
  const seen = [];
  session.subscribe((event) => seen.push(event.type));

  const pendingResponse = postJson(captured.launchContext.approvalUrl, {
    runId: 's1',
    toolName: 'Bash',
    input: { command: 'rm -rf build' },
    toolUseId: 'tu1'
  });
  const interaction = await waitFor(() => firstPending(session));

  assert.equal(interaction.kind, 'approval');
  assert.equal(interaction.itemId, 'tu1');
  assert.equal(interaction.payload.presentation.title, '允许执行 Bash 吗？');
  assert.equal(interaction.payload.presentation.detail, 'rm -rf build');
  assert.deepEqual(
    interaction.payload.choices.map((choice) => choice.intent),
    ['accept', 'deny']
  );

  session.respond(interaction.interactionId, { choiceId: 'allow' });
  const response = await pendingResponse;
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    behavior: 'allow',
    updatedInput: { command: 'rm -rf build' }
  });
  assert.ok(seen.includes('interaction.requested'));
  assert.ok(seen.includes('interaction.resolved'));

  session.dispose('done');
});

test('approval 拒绝：choiceId=deny 回 deny 且不带 updatedInput', async () => {
  const { session, captured } = setup();
  await session.open({ mode: 'confirm' });
  const pendingResponse = postJson(captured.launchContext.approvalUrl, {
    toolName: 'Write',
    input: { file_path: '/etc/hosts' },
    toolUseId: 'tu2'
  });
  const interaction = await waitFor(() => firstPending(session));
  assert.equal(interaction.payload.presentation.detail, '/etc/hosts');
  session.respond(interaction.interactionId, { choiceId: 'deny' });
  const response = await pendingResponse;
  assert.equal(response.body.behavior, 'deny');
  assert.equal(response.body.updatedInput, undefined);
  assert.ok(response.body.message);
  session.dispose('done');
});

test('ExitPlanMode → plan_confirmation（计划正文进 presentation.message）', async () => {
  const { session, captured } = setup();
  await session.open({ mode: 'plan' });
  const pendingResponse = postJson(captured.launchContext.approvalUrl, {
    toolName: 'ExitPlanMode',
    input: { plan: '1. 改 adapter\n2. 跑测试' },
    toolUseId: 'tu-plan'
  });
  const interaction = await waitFor(() => firstPending(session));
  assert.equal(interaction.kind, 'plan_confirmation');
  assert.deepEqual(interaction.payload.actions, ['submit', 'cancel']);
  assert.equal(interaction.payload.answerShape, 'none');
  assert.match(interaction.payload.presentation.message, /改 adapter/);

  session.respond(interaction.interactionId, { action: 'submit' });
  const response = await pendingResponse;
  assert.equal(response.body.behavior, 'allow');
  session.dispose('done');
});

test('AskUserQuestion → question，answers 回写进 updatedInput', async () => {
  const { session, captured } = setup();
  await session.open({ mode: 'confirm' });
  const pendingResponse = postJson(captured.launchContext.approvalUrl, {
    toolName: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: '用哪个数据库？',
          header: 'DB',
          options: [{ label: 'postgres' }, { label: 'sqlite', description: '本地文件' }],
          multiSelect: false
        },
        {
          question: '要哪些环境？',
          options: [{ label: 'dev' }, { label: 'prod' }],
          multiSelect: true
        }
      ]
    },
    toolUseId: 'tu-q'
  });
  const interaction = await waitFor(() => firstPending(session));
  assert.equal(interaction.kind, 'question');
  assert.deepEqual(interaction.payload.actions, ['submit', 'cancel']);
  assert.deepEqual(
    interaction.payload.fields.map((field) => [field.id, field.type, field.allowOther]),
    [['用哪个数据库？', 'single_select', true], ['要哪些环境？', 'multi_select', false]]
  );
  assert.deepEqual(
    interaction.payload.fields[0].options.map((option) => option.value),
    ['postgres', 'sqlite']
  );

  session.respond(interaction.interactionId, {
    action: 'submit',
    answers: { '用哪个数据库？': 'postgres', '要哪些环境？': ['dev'] }
  });
  const response = await pendingResponse;
  assert.deepEqual(response.body, {
    behavior: 'allow',
    updatedInput: { answers: { '用哪个数据库？': 'postgres', '要哪些环境？': ['dev'] } }
  });
  session.dispose('done');
});

test('token 不对的请求被 403 拒绝，且不产生任何交互', async () => {
  const { session, captured } = setup();
  await session.open({ mode: 'confirm' });
  const url = new URL(captured.launchContext.approvalUrl);
  const wrong = url.pathname.slice(0, -1) + (url.pathname.endsWith('a') ? 'b' : 'a');
  const response = await postJson(`http://${url.host}${wrong}`, {
    toolName: 'Bash',
    input: { command: 'echo hi' },
    toolUseId: 'tu-bad'
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.behavior, 'deny');
  assert.equal(session.router.pendingCount(), 0);
  session.dispose('done');
});

test('超时：桥回 deny，router 侧走 interaction.expired', async () => {
  const { session, captured } = setup({ approvalTimeoutMs: 40, interactionTimeoutMs: 40 });
  await session.open({ mode: 'confirm' });
  const seen = [];
  session.subscribe((event) => seen.push(event));
  const pendingResponse = postJson(captured.launchContext.approvalUrl, {
    toolName: 'Bash',
    input: { command: 'sleep 1' },
    toolUseId: 'tu-timeout'
  });
  const response = await pendingResponse;
  assert.equal(response.body.behavior, 'deny');
  assert.match(response.body.message, /超时/);
  await waitFor(() => seen.some((event) => event.type === 'interaction.expired'));
  assert.equal(session.router.pendingCount(), 0);
  session.dispose('done');
});

test('dispose：在飞请求全部 deny，桥关闭，临时 launch context 被删', async () => {
  const { session, captured } = setup();
  await session.open({ mode: 'confirm' });
  const seen = [];
  session.subscribe((event) => seen.push(event.type));
  const pendingResponse = postJson(captured.launchContext.approvalUrl, {
    toolName: 'Bash',
    input: { command: 'curl example.com' },
    toolUseId: 'tu-dispose'
  });
  await waitFor(() => firstPending(session));

  session.dispose('bye');
  const response = await pendingResponse;
  assert.equal(response.body.behavior, 'deny');
  assert.match(response.body.message, /会话已结束/);
  assert.ok(seen.includes('interaction.expired'));
  assert.equal(captured.removed, '/tmp/aih-fake-launch-context.json');
  // 桥已关闭：连接要么被拒、要么被立刻挂断，两种都说明不再服务。
  await assert.rejects(() => postJson(captured.launchContext.approvalUrl, {
    toolName: 'Bash',
    input: {}
  }));
});

test('prompt：NDJSON 结果行决定 stopReason，assistant 文本进 timeline 事件', async () => {
  const { session, child } = setup();
  await session.open({ mode: 'confirm' });
  const seen = [];
  session.subscribe((event) => seen.push(event));

  const turn = session.prompt({ text: '你好' });
  await waitFor(() => child.stdin.writes.length > 0);
  const written = JSON.parse(child.stdin.writes[0]);
  assert.equal(written.type, 'user');
  assert.deepEqual(written.message.content, [{ type: 'text', text: '你好' }]);

  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '在的' }] }
  });
  child.emitLine({ type: 'result', subtype: 'success', stop_reason: 'end_turn' });

  const result = await turn;
  assert.equal(result.stopReason, 'end_turn');
  assert.ok(seen.some((event) => event.type === 'timeline.item.completed'
    && event.payload.kind === 'message'
    && event.payload.text === '在的'));
  session.dispose('done');
});

test('prompt 失败：result 子类型非 success 时 turn.failed', async () => {
  const { session, child } = setup();
  await session.open({ mode: 'confirm' });
  const turn = session.prompt({ text: 'hi' });
  await waitFor(() => child.stdin.writes.length > 0);
  child.emitLine({ type: 'result', subtype: 'error_max_turns', is_error: true });
  await assert.rejects(() => turn, (error) => error.code === 'claude_turn_failed');
  session.dispose('done');
});

test('cancel：在飞 turn 立即拒绝，挂起交互全部 deny', async () => {
  const { session, captured, child } = setup();
  await session.open({ mode: 'confirm' });
  const turn = session.prompt({ text: 'hi' });
  await waitFor(() => child.stdin.writes.length > 0);
  const pendingResponse = postJson(captured.launchContext.approvalUrl, {
    toolName: 'Bash',
    input: { command: 'ls' },
    toolUseId: 'tu-cancel'
  });
  await waitFor(() => firstPending(session));
  // 先挂上结果处理：cancel 是同步 reject，晚一步就是 unhandled rejection。
  const turnOutcome = turn.then(() => 'resolved', (error) => error.code);
  const cancelled = session.cancel('user');
  const response = await pendingResponse;
  assert.equal(response.body.behavior, 'deny');
  assert.equal(await turnOutcome, 'claude_turn_cancelled');
  await cancelled;
  assert.deepEqual(child.killed, ['SIGTERM']);
  session.dispose('done');
});

test('bypass 模式不建桥、不带权限工具参数', async () => {
  const { session, captured, spawns } = setup();
  await session.open({ mode: 'bypass' });
  assert.equal(captured.launchContext, null);
  assert.equal(spawns[0].args.includes('--permission-prompt-tool'), false);
  session.dispose('done');
});
