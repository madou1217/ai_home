'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const {
  supportsQoderCliTransport,
  buildQoderCliPrompt,
  fetchQoderCliChatCompletion,
  fetchQoderCliChatCompletionStream,
  __private
} = require('../lib/server/qoder-cli-transport');
const { createQoderCliWarmPool } = require('../lib/server/qoder-cli-warm-pool');
const { qoderCliTransport } = require('../lib/server/upstream-endpoints-transport-qoder-cli');
const { runTransportChain } = require('../lib/server/upstream-endpoints-transport-chain');

const ACCOUNT = { provider: 'qodercn', accountRef: 'acct_63044849a0f6d3b8ee09' };

function fakeChild(lines, code = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write() {},
    end() {
      setImmediate(() => {
        for (const line of lines) child.stdout.emit('data', Buffer.from(`${line}\n`));
        child.emit('close', code);
      });
    }
  };
  child.kill = () => {};
  return child;
}

function makeDeps(lines, code = 0) {
  const invocations = [];
  return {
    invocations,
    aiHomeDir: '/tmp/aih-qoder-test',
    hostHomeDir: '/tmp',
    materializeProviderAuth: () => ({ materialized: 1, removed: 0, missing: false }),
    resolveProviderCliPath: () => '/usr/bin/qoderclicn',
    spawn: (command, args) => {
      invocations.push({ command, args });
      return fakeChild(lines, code);
    }
  };
}

const OK_LINES = [
  '{"type":"system","subtype":"init","session_id":"s-1","model":"qmodel_38max"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello world"}]}}',
  '{"type":"result","subtype":"success","result":"hello world","usage":{"input_tokens":10,"output_tokens":5}}'
];

test('supportsQoderCliTransport gates qoder variants only', () => {
  assert.equal(supportsQoderCliTransport('qoder'), true);
  assert.equal(supportsQoderCliTransport('qodercn'), true);
  assert.equal(supportsQoderCliTransport('QODERCN'), true);
  assert.equal(supportsQoderCliTransport('codex'), false);
  assert.equal(supportsQoderCliTransport('kimi'), false);
});

test('buildQoderCliPrompt flattens messages with role labels and keeps image placeholders', () => {
  const prompt = buildQoderCliPrompt({
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: [{ type: 'text', text: '回答一' }] },
      { role: 'user', content: [{ type: 'text', text: '带图' }, { type: 'image_url', image_url: { url: 'data:...' } }] }
    ]
  });
  assert.ok(prompt.startsWith('以下是完整的对话记录，请作为 Assistant 回复最后一条 User 消息。'));
  assert.ok(prompt.includes('本环境没有文件/命令工具'), 'prompt must declare that no CLI tools are available');
  assert.ok(prompt.includes('System:\n你是助手'));
  assert.ok(prompt.includes('User:\n第一句'));
  assert.ok(prompt.includes('Assistant:\n回答一'));
  assert.ok(prompt.includes('带图'));
  assert.ok(prompt.includes('[图片附件暂不支持经 Qoder CLI 通道发送]'));
  assert.ok(prompt.includes('【对话记录开始】'));
  assert.ok(prompt.includes('【对话记录结束】'));
  assert.ok(prompt.includes('请作为 Assistant 直接回复【最后一条 User 消息】。'));
  assert.ok(prompt.endsWith('Assistant:'));
  assert.equal(buildQoderCliPrompt({ messages: [] }), '');
  assert.equal(buildQoderCliPrompt({}), '');
});

// 回归（2026-10-16 驴头不对马嘴事故）：上游会把记录末尾的一条当成背景，只回「已就绪」；
// 因此提示开头必须点名最后一条 User 消息正文，超长时截断点名、完整正文留在记录里。
test('buildQoderCliPrompt anchors the last user message at the top of the transcript', () => {
  const prompt = buildQoderCliPrompt({
    messages: [
      { role: 'user', content: '聊天策略块' },
      { role: 'user', content: '技能清单块' },
      { role: 'assistant', content: '历史回答' },
      { role: 'user', content: '生成一个鹈鹕骑自行车的 3D 页面' }
    ]
  });
  const calloutZone = prompt.slice(0, prompt.indexOf('【对话记录开始】'));
  assert.ok(calloutZone.includes('【最后一条 User 消息（需要你直接回复的内容）】'));
  assert.ok(calloutZone.includes('生成一个鹈鹕骑自行车的 3D 页面'));
  assert.ok(!calloutZone.includes('聊天策略块'), 'callout must only carry the last user message');
  const transcriptZone = prompt.slice(prompt.indexOf('【对话记录开始】'));
  assert.ok(transcriptZone.includes('User:\n生成一个鹈鹕骑自行车的 3D 页面'));

  const long = 'x'.repeat(5000);
  const longPrompt = buildQoderCliPrompt({ messages: [{ role: 'user', content: long }] });
  const longCalloutZone = longPrompt.slice(0, longPrompt.indexOf('【对话记录开始】'));
  assert.ok(longCalloutZone.length < 2300, 'oversized callout must be clipped');
  assert.ok(longCalloutZone.includes('完整正文见下方【对话记录】末尾'));
  assert.ok(longPrompt.includes(long), 'full text must stay in the transcript');
});

test('buildQoderCliPrompt without a user message keeps the plain transcript form', () => {
  const prompt = buildQoderCliPrompt({ messages: [{ role: 'system', content: '只有系统块' }] });
  assert.ok(prompt.includes('System:\n只有系统块'));
  assert.ok(!prompt.includes('【最后一条 User 消息'));
  assert.ok(prompt.endsWith('Assistant:'));
});

test('readResultErrorMessage maps the pricingUrl quota wall to a readable message', () => {
  const quota = __private.readResultErrorMessage({
    is_error: true,
    errors: ['{"pricingUrl":"https://qoder.com.cn/pricing?client=qoder"}']
  });
  assert.match(quota, /套餐\/额度不足/);
  assert.match(quota, /118/);
  assert.equal(
    __private.readResultErrorMessage({ is_error: true, errors: ['plain failure'] }),
    'plain failure'
  );
});

test('runQoderCliTurn spawns headless CLI, streams deltas, resolves content and usage', async () => {
  const deps = makeDeps(OK_LINES);
  const deltas = [];
  const result = await __private.runQoderCliTurn(
    { aiHomeDir: '/tmp/aih-qoder-test' },
    ACCOUNT,
    { model: 'Qwen3.8-Max', messages: [{ role: 'user', content: 'hi' }] },
    1000,
    deps,
    (delta) => deltas.push(delta)
  );
  assert.equal(result.content, 'hello world');
  assert.equal(result.sessionId, 's-1');
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.equal(result.model, 'qmodel_38max');
  assert.deepEqual(deltas, ['hello', ' world']);
  const { command, args } = deps.invocations[0];
  assert.equal(command, '/usr/bin/qoderclicn');
  assert.ok(args.includes('--print'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--include-partial-messages'), 'partial messages keep long answers alive');
  assert.ok(args.includes('--max-turns'));
  const toolsIndex = args.indexOf('--tools');
  assert.ok(toolsIndex > -1, 'CLI built-in tools must be disabled for a chat-only relay');
  assert.equal(args[toolsIndex + 1], '');
  const modelIndex = args.indexOf('--model');
  assert.equal(args[modelIndex + 1], 'Qwen3.8-Max');
  const configDirIndex = args.indexOf('--config-dir');
  assert.ok(String(args[configDirIndex + 1]).includes('acct_63044849a0f6d3b8ee09'));
});

test('runQoderCliTurn dedupes partial events and estimates usage from context ratio', async () => {
  const deps = makeDeps([
    '{"type":"system","subtype":"init","session_id":"s-est","model":"Qwen3.8-Flash"}',
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"想"}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}}',
    // CLI 在 partial delta 之后仍会发一次完整 assistant 消息：不能再重复一遍。
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"想"},{"type":"text","text":"你好"}]}}',
    '{"type":"result","subtype":"success","result":"你好","usage":{"input_tokens":0,"output_tokens":0,"credits":0.25,"billable":true,"context_usage_ratio":0.1,"request_id":"req-est"}}'
  ]);
  const deltas = [];
  const result = await __private.runQoderCliTurn(
    {},
    ACCOUNT,
    { model: 'Qwen3.8-Flash', messages: [{ role: 'user', content: 'hi' }] },
    1000,
    deps,
    (delta) => deltas.push(delta)
  );
  assert.deepEqual(deltas, ['你', '好']);
  assert.equal(result.content, '你好');
  assert.equal(result.usageEstimated, true);
  assert.deepEqual(result.usage, {
    prompt_tokens: 20000,
    completion_tokens: 3,
    total_tokens: 20003
  });
  assert.equal(result.usageEvidence.credits, 0.25);
  assert.equal(result.usageEvidence.billable, true);
  assert.equal(result.usageEvidence.requestId, 'req-est');
});

test('runQoderCliTurn captures the upstream message id as the usage idempotency key', async () => {
  const deps = makeDeps([
    '{"type":"system","subtype":"init","session_id":"s-id","model":"Qwen3.8-Flash"}',
    '{"type":"assistant","message":{"id":"chatcmpl-usage-1","role":"assistant","model":"qfmodel","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":0,"output_tokens":0,"context_usage_ratio":0.1}}}',
    '{"type":"result","subtype":"success","result":"hi","usage":{"input_tokens":0,"output_tokens":0,"context_usage_ratio":0.1,"request_id":"req-1"}}'
  ]);
  const result = await __private.runQoderCliTurn(
    {},
    ACCOUNT,
    { model: 'Qwen3.8-Flash', messages: [{ role: 'user', content: 'hi' }] },
    1000,
    deps
  );
  assert.equal(result.messageId, 'chatcmpl-usage-1');
  const payload = __private.buildChatCompletionPayload(result, 'Qwen3.8-Flash');
  assert.equal(payload.usageMessageId, 'chatcmpl-usage-1');
  assert.equal(Object.prototype.propertyIsEnumerable.call(payload, 'usageMessageId'), false,
    'the id must not leak into the OpenAI response body');
});

test('runQoderCliTurn kills a silent CLI on the shared idle watchdog', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = () => {};
  const deps = {
    ...makeDeps([]),
    spawn: () => child,
    cliIdleTimeoutMs: 30
  };
  const startedAt = Date.now();
  // 看门狗定时器是 unref 的（生产里子进程本身撑住事件循环）；假子进程没有真实句柄，
  // 测试自己持有一个 ref 定时器，避免 node:test 提前收尾。
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      __private.runQoderCliTurn({}, ACCOUNT, { messages: [{ role: 'user', content: 'hi' }] }, 1000, deps),
      (error) => error.code === 'qoder_cli_timeout' && /qoder_cli_no_output_30ms/.test(error.message)
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(Date.now() - startedAt < 1000, 'idle watchdog must fire without waiting the old 120s wall clock');
});

test('runQoderCliTurn surfaces the upstream quota wall instead of a generic failure', async () => {
  const deps = makeDeps([
    '{"type":"system","subtype":"init","session_id":"s-2"}',
    '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["{\\"pricingUrl\\":\\"https://qoder.com.cn/pricing?client=qoder\\"}"],"error_code":118}'
  ]);
  await assert.rejects(
    __private.runQoderCliTurn({}, ACCOUNT, { messages: [{ role: 'user', content: 'hi' }] }, 1000, deps),
    (error) => error.code === 'qoder_cli_quota_exceeded' && /套餐\/额度不足/.test(error.message)
  );
});

test('runQoderCliTurn rejects non-zero exit without content', async () => {
  const deps = makeDeps([], 1);
  await assert.rejects(
    __private.runQoderCliTurn({}, ACCOUNT, { messages: [{ role: 'user', content: 'hi' }] }, 1000, deps),
    (error) => error.code === 'qoder_cli_exit_nonzero'
  );
});

test('runQoderCliTurn suppresses CLI synthetic error placeholders from deltas', async () => {
  const deps = makeDeps([
    '{"type":"system","subtype":"init","session_id":"s-3"}',
    '{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"{\\"pricingUrl\\":\\"https://qoder.com.cn/pricing?client=qoder\\"}"}]}}',
    '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["{\\"pricingUrl\\":\\"https://qoder.com.cn/pricing?client=qoder\\"}"],"error_code":118}'
  ]);
  const deltas = [];
  await assert.rejects(
    __private.runQoderCliTurn({}, ACCOUNT, { messages: [{ role: 'user', content: 'hi' }] }, 1000, deps, (delta) => deltas.push(delta)),
    (error) => error.code === 'qoder_cli_quota_exceeded' && /套餐\/额度不足/.test(error.message)
  );
  assert.deepEqual(deltas, [], 'synthetic quota-wall placeholder must not leak into assistant deltas');
});

test('fetchQoderCliChatCompletion returns an OpenAI chat completion payload', async () => {
  const deps = makeDeps(OK_LINES);
  const payload = await fetchQoderCliChatCompletion({}, ACCOUNT, { model: 'Qwen3.8-Max', messages: [{ role: 'user', content: 'hi' }] }, 1000, deps);
  assert.equal(payload.object, 'chat.completion');
  assert.equal(payload.model, 'Qwen3.8-Max');
  assert.equal(payload.choices[0].message.role, 'assistant');
  assert.equal(payload.choices[0].message.content, 'hello world');
  assert.equal(payload.choices[0].finish_reason, 'stop');
  assert.deepEqual(payload.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test('fetchQoderCliChatCompletionStream emits OpenAI SSE chunks live', async () => {
  const deps = makeDeps(OK_LINES);
  const upstream = await fetchQoderCliChatCompletionStream({}, ACCOUNT, { model: 'Qwen3.8-Max', messages: [{ role: 'user', content: 'hi' }] }, 1000, deps);
  assert.equal(upstream.ok, true);
  const text = await new Promise((resolve, reject) => {
    let buf = '';
    upstream.body.on('data', (chunk) => { buf += chunk.toString('utf8'); });
    upstream.body.on('end', () => resolve(buf));
    upstream.body.on('error', reject);
  });
  const frames = text.split('\n\n').filter(Boolean);
  assert.match(frames[0], /"role":"assistant"/);
  assert.match(frames[1], /"content":"hello"/);
  assert.match(frames[2], /"content":" world"/);
  assert.match(frames[3], /"finish_reason":"stop"/);
  assert.match(frames[3], /"usage":\{"prompt_tokens":10/);
  assert.equal(frames[4], 'data: [DONE]');
});

test('qoderCliTransport matches qoder variants and runTransportChain dispatches to it', async () => {
  assert.equal(qoderCliTransport.matches({ provider: 'qoder' }), true);
  assert.equal(qoderCliTransport.matches({ provider: 'qodercn' }), true);
  assert.equal(qoderCliTransport.matches({ provider: 'codex' }), false);
  assert.equal(qoderCliTransport.matches(null), false);

  const sent = { status: 0, headers: {}, body: '' };
  const res = {
    statusCode: 0,
    setHeader(key, value) { sent.headers[key] = value; },
    end(body) { sent.body = body ? body.toString() : ''; },
    write(chunk) { sent.body += chunk.toString(); },
    get headersSent() { return true; },
    get writableEnded() { return false; }
  };
  const deps = makeDeps(OK_LINES);
  const action = await runTransportChain({
    options: {},
    res,
    requestJson: { model: 'Qwen3.8-Max', messages: [{ role: 'user', content: 'hi' }] },
    provider: 'qodercn',
    streamRequested: false,
    requestMeta: {},
    state: { metrics: { providerFailures: {} } },
    deps: {
      fetchQoderCliChatCompletion: (options, account, requestJson, timeoutMs) =>
        fetchQoderCliChatCompletion(options, account, requestJson, timeoutMs, deps)
    },
    recordAccountSuccess: () => {},
    recordAccountFailure: () => {},
    recordModelUsage: () => {},
    appendProxyRequestLog: () => {},
    diagnosticMaxAttempts: () => 1,
    control: { attempt: 0, setLastError() {} },
    account: ACCOUNT,
    attemptUpstreamTimeoutMs: 1000,
    attemptMutable: {}
  }, [qoderCliTransport]);
  assert.deepEqual(action, { action: 'return' });
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(sent.body);
  assert.equal(payload.choices[0].message.content, 'hello world');
  assert.equal(sent.headers['x-aih-server-account-ref'], ACCOUNT.accountRef);
});

test('streaming qoder transport shares the JSONL usage event key', async () => {
  const recorded = [];
  const sent = { status: 0, headers: {}, body: '' };
  const res = {
    statusCode: 0,
    setHeader(key, value) { sent.headers[key] = value; },
    end(body) { sent.body = body ? body.toString() : ''; },
    write(chunk) { sent.body += chunk.toString(); return true; },
    get headersSent() { return true; },
    get writableEnded() { return false; }
  };
  const deps = makeDeps([
    '{"type":"system","subtype":"init","session_id":"s-stream","model":"Qwen3.8-Flash"}',
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}',
    '{"type":"assistant","message":{"id":"chatcmpl-stream-1","role":"assistant","model":"qfmodel","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":0,"output_tokens":0,"context_usage_ratio":0.1}}}',
    '{"type":"result","subtype":"success","result":"hi","usage":{"input_tokens":0,"output_tokens":0,"context_usage_ratio":0.1}}'
  ]);
  const action = await runTransportChain({
    options: {},
    res,
    requestJson: { model: 'Qwen3.8-Flash', messages: [{ role: 'user', content: 'hi' }] },
    provider: 'qodercn',
    streamRequested: true,
    requestMeta: {},
    state: { metrics: { providerFailures: {} } },
    deps: {
      fetchQoderCliChatCompletionStream: (options, account, requestJson, timeoutMs, extraDeps) =>
        fetchQoderCliChatCompletionStream(options, account, requestJson, timeoutMs, { ...deps, ...extraDeps })
    },
    recordAccountSuccess: () => {},
    recordAccountFailure: () => {},
    recordModelUsage: (record) => recorded.push(record),
    appendProxyRequestLog: () => {},
    diagnosticMaxAttempts: () => 1,
    control: { attempt: 0, setLastError() {} },
    account: ACCOUNT,
    attemptUpstreamTimeoutMs: 1000,
    attemptMutable: {}
  }, [qoderCliTransport]);
  assert.deepEqual(action, { action: 'return' });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].eventKey, 'qodercn:message:chatcmpl-stream-1');
  assert.equal(recorded[0].sourceKind, 'server_qoder_cli_proxy_estimated');
});

// ---- warm CLI 会话池 ---------------------------------------------------------

function fakePersistentChild(replyForInput) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    written: [],
    write(line) {
      this.written.push(line);
      let input = null;
      try { input = JSON.parse(line); } catch (_error) { input = null; }
      const reply = replyForInput(input);
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          type: 'system', subtype: 'init', session_id: 's-warm', model: 'Qwen3.8-Flash'
        })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } }
        })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          type: 'result', subtype: 'success', result: reply,
          usage: { input_tokens: 1, output_tokens: 1 }
        })}\n`));
      });
    },
    end() {}
  };
  child.kill = () => {};
  return child;
}

function warmDeps(children, replyForInput) {
  const pool = createQoderCliWarmPool({
    spawn: () => {
      const child = fakePersistentChild(replyForInput);
      children.push(child);
      return child;
    },
    killGraceMs: 0
  });
  return {
    ...makeDeps([]),
    spawn: () => { throw new Error('cold spawn must not be used while warm reuse is possible'); },
    qoderWarmPool: pool,
    sessionKey: 'session-warm-1'
  };
}

test('warm CLI reuses one process for the same session and sends only the new user message', async () => {
  const children = [];
  const deps = warmDeps(children, (input) => {
    const text = input && input.message && input.message.content && input.message.content[0]
      ? input.message.content[0].text
      : '';
    return text === 'again' ? 'pong-again' : 'pong';
  });
  const first = await __private.runQoderCliTurnAutomatic(
    {},
    ACCOUNT,
    { model: 'Qwen3.8-Flash', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }] },
    1000,
    deps
  );
  assert.equal(first.content, 'pong');
  assert.equal(first.warm, true);
  assert.equal(first.warmReused, false);
  assert.equal(children.length, 1);
  assert.equal(children[0].stdin.written.length, 1);
  assert.ok(children[0].stdin.written[0].includes('【对话记录开始】'), 'first turn must carry the full transcript');

  const second = await __private.runQoderCliTurnAutomatic(
    {},
    ACCOUNT,
    {
      model: 'Qwen3.8-Flash',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'pong' },
        { role: 'user', content: 'again' }
      ]
    },
    1000,
    deps
  );
  assert.equal(second.content, 'pong-again');
  assert.equal(second.warm, true);
  assert.equal(second.warmReused, true);
  assert.equal(children.length, 1, 'second turn must reuse the same CLI process');
  assert.equal(children[0].stdin.written.length, 2);
  const secondInput = JSON.parse(children[0].stdin.written[1]);
  assert.equal(secondInput.message.content[0].text, 'again', 'warm turn must send only the delta user message');
  assert.ok(!children[0].stdin.written[1].includes('【对话记录开始】'));
});

test('warm CLI starts a fresh process when the conversation prefix changed', async () => {
  const children = [];
  const deps = warmDeps(children, () => 'pong');
  await __private.runQoderCliTurnAutomatic(
    {},
    ACCOUNT,
    { model: 'Qwen3.8-Flash', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }] },
    1000,
    deps
  );
  const changed = await __private.runQoderCliTurnAutomatic(
    {},
    ACCOUNT,
    {
      model: 'Qwen3.8-Flash',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'a different answer' },
        { role: 'user', content: 'again' }
      ]
    },
    1000,
    deps
  );
  assert.equal(changed.warmReused, false);
  assert.equal(children.length, 2, 'prefix mismatch must spawn a new CLI process');
  assert.ok(children[1].stdin.written[0].includes('【对话记录开始】'), 'fresh process must get the full transcript');
});

test('warm CLI is skipped without a session key and uses the cold one-shot path', async () => {
  let acquireCalls = 0;
  const deps = {
    ...makeDeps(OK_LINES),
    sessionKey: '',
    qoderWarmPool: {
      get: () => null,
      acquire: () => { acquireCalls += 1; return null; }
    }
  };
  const result = await __private.runQoderCliTurnAutomatic(
    {},
    ACCOUNT,
    { model: 'Qwen3.8-Max', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] },
    1000,
    deps
  );
  assert.equal(result.content, 'hello world');
  assert.equal(result.warm, undefined);
  assert.equal(acquireCalls, 0);
  assert.equal(deps.invocations.length, 1);
});

test('warm CLI falls back to a cold turn when the pooled process exits before any delta', async () => {
  const deps = {
    ...makeDeps(OK_LINES),
    sessionKey: 'session-fallback',
    qoderWarmPool: {
      get: () => null,
      acquire: () => ({ key: 'k', state: 'idle', sessionId: '', historyHash: '' }),
      sendTurn: async () => {
        throw Object.assign(new Error('qoder_cli_warm_exit_1'), { code: 'qoder_cli_warm_exit' });
      },
      failTurn: () => {},
      discard: () => {}
    }
  };
  const result = await __private.runQoderCliTurnAutomatic(
    {},
    ACCOUNT,
    { model: 'Qwen3.8-Max', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] },
    1000,
    deps
  );
  assert.equal(result.content, 'hello world');
  assert.equal(result.warm, undefined);
  assert.equal(deps.invocations.length, 1, 'warm failure must fall back to exactly one cold spawn');
});

test('qoder transport records estimated usage with an explicit estimated sourceKind', async () => {
  const recorded = [];
  const sent = { status: 0, headers: {}, body: '' };
  const res = {
    statusCode: 0,
    setHeader(key, value) { sent.headers[key] = value; },
    end(body) { sent.body = body ? body.toString() : ''; },
    write(chunk) { sent.body += chunk.toString(); },
    get headersSent() { return true; },
    get writableEnded() { return false; }
  };
  const deps = makeDeps([
    '{"type":"system","subtype":"init","session_id":"s-est","model":"qmodel"}',
    '{"type":"assistant","message":{"id":"chatcmpl-est-1","role":"assistant","model":"qmodel","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":0,"output_tokens":0,"context_usage_ratio":0.1}}}',
    '{"type":"result","subtype":"success","result":"hi","usage":{"input_tokens":0,"output_tokens":0,"context_usage_ratio":0.1}}'
  ]);
  const action = await runTransportChain({
    options: {},
    res,
    requestJson: { model: 'Qwen3.8-Max', messages: [{ role: 'user', content: 'hi' }] },
    provider: 'qodercn',
    streamRequested: false,
    requestMeta: {},
    state: { metrics: { providerFailures: {} } },
    deps: {
      fetchQoderCliChatCompletion: (options, account, requestJson, timeoutMs, extraDeps) =>
        fetchQoderCliChatCompletion(options, account, requestJson, timeoutMs, { ...deps, ...extraDeps })
    },
    recordAccountSuccess: () => {},
    recordAccountFailure: () => {},
    recordModelUsage: (record) => recorded.push(record),
    appendProxyRequestLog: () => {},
    diagnosticMaxAttempts: () => 1,
    control: { attempt: 0, setLastError() {} },
    account: ACCOUNT,
    attemptUpstreamTimeoutMs: 1000,
    attemptMutable: {}
  }, [qoderCliTransport]);
  assert.deepEqual(action, { action: 'return' });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].sourceKind, 'server_qoder_cli_proxy_estimated');
  assert.equal(recorded[0].eventKey, 'qodercn:message:chatcmpl-est-1',
    'the live path must reuse the JSONL scanner event key');
  assert.ok(recorded[0].usage.prompt_tokens > 0);
});
