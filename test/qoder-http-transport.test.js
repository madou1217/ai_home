'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const {
  QODER_HTTP_TRANSPORT_ID,
  supportsQoderHttpTransport,
  buildQoderHttpRequestBody,
  fetchQoderHttpChatCompletion,
  fetchQoderHttpChatCompletionStream,
  __private: {
    aggregateQoderHttpChunks,
    createQoderSsePump,
    normalizeQoderHttpTools,
    parseQoderSseEnvelope,
    readSseBlockData,
    resolveQoderClientVersion
  }
} = require('../lib/server/qoder-http-transport');

function envelope(body, statusCodeValue = 200) {
  return JSON.stringify({
    headers: {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
    statusCodeValue,
    statusCode: statusCodeValue === 200 ? 'OK' : 'ERR'
  });
}

function sseText(frames) {
  return frames.map((frame) => `data: ${frame}\n\n`).join('');
}

function waitForBody(stream) {
  return new Promise((resolve, reject) => {
    const parts = [];
    stream.on('data', (chunk) => parts.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    stream.on('error', reject);
  });
}

test('qoder http transport only claims qoder providers', () => {
  assert.equal(supportsQoderHttpTransport('qoder'), true);
  assert.equal(supportsQoderHttpTransport('qodercn'), true);
  assert.equal(supportsQoderHttpTransport('Qoder'), true);
  assert.equal(supportsQoderHttpTransport('claude'), false);
  assert.equal(supportsQoderHttpTransport(null), false);
  assert.equal(QODER_HTTP_TRANSPORT_ID, 'qoder_http_sse');
});

test('buildQoderHttpRequestBody mirrors the captured single-user body shape', () => {
  const result = buildQoderHttpRequestBody({
    model: 'auto',
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '只回复 OK' }
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file.',
        parameters: { type: 'object', properties: { path: { type: 'string' } } }
      }
    }],
    max_tokens: 4096
  }, { provider: 'qodercn', version: '1.1.72' });

  const body = result.body;
  assert.equal(body.session_type, 'qoderclicn');
  assert.equal(body.agent_id, 'agent_common');
  assert.equal(body.task_id, 'common');
  assert.equal(body.chat_task, 'FREE_INPUT');
  assert.equal(body.stream, true);
  assert.equal(body.business.stage, 'start');
  assert.equal(body.business.model_key, 'auto');
  assert.equal(body.model_config.key, 'auto');
  assert.equal(body.model_config.is_reasoning, false);
  // system 同时出现在独立 system 数组与 messages[0]（与真机 body 同形）。
  assert.deepEqual(body.system, [{ type: 'text', text: 'system prompt' }]);
  assert.deepEqual(body.messages[0], { role: 'system', content: body.system });
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].role, 'user');
  assert.equal(body.messages[1].content, '只回复 OK');
  assert.equal(body.chat_context.text, '只回复 OK');
  assert.equal(body.chat_context.extra.originalContent, '只回复 OK');
  assert.equal(body.business.name, '只回复 OK');
  // 真机抓包无 flow 字段；带上会触发 agent_router 的 flow 查找错误。
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'flow'), false);
  assert.equal(body.parameters.max_tokens, 4096);
  assert.equal(result.toolCount, 1);
  assert.equal(body.tools[0].function.name, 'read_file');
  assert.equal(body.tools[0].function.parameters.type, 'object');

  const qoder = buildQoderHttpRequestBody({
    model: 'qoder/auto',
    messages: [{ role: 'user', content: 'hi' }]
  }, { provider: 'qoder', version: '1.1.73' });
  assert.equal(qoder.body.session_type, 'qodercli');
  assert.equal(qoder.body.model_config.key, 'auto');
  assert.equal(qoder.body.chat_context.text, 'hi');
});

test('buildQoderHttpRequestBody flattens multi-turn tool history into one transcript', () => {
  const result = buildQoderHttpRequestBody({
    model: 'Qwen3.8-Max',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'read the file' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"/tmp/a"}' }
        }]
      },
      { role: 'tool', tool_call_id: 'call-1', name: 'read_file', content: 'file-body' },
      { role: 'user', content: 'summarize it' }
    ]
  }, { provider: 'qodercn', version: '1.1.72' });

  const prompt = result.body.messages[1].content;
  assert.match(prompt, /User:\nread the file/);
  assert.match(prompt, /Assistant:\n\[调用工具 read_file\]\n\{"path":"\/tmp\/a"\}/);
  assert.match(prompt, /Tool:\nfile-body/);
  assert.match(prompt, /User:\nsummarize it/);
  assert.equal(result.body.model_config.key, 'Qwen3.8-Max');
  assert.equal(result.body.model_config.is_reasoning, false);
});

test('buildQoderHttpRequestBody resolves aliases and reasoning model variants', () => {
  const alias = buildQoderHttpRequestBody({
    model: 'qoder/Qwen3.8-Max',
    messages: [{ role: 'user', content: 'hi' }]
  }, {
    provider: 'qoder',
    version: '1.1.73',
    requestMeta: { aliasResolution: { effectiveModel: 'qoder/auto' } }
  });
  assert.equal(alias.body.model_config.key, 'auto');

  const reasoning = buildQoderHttpRequestBody({
    model: 'qoder/Qwen3.8-Thinking',
    messages: [{ role: 'user', content: 'hi' }]
  }, { provider: 'qoder', version: '1.1.73' });
  assert.equal(reasoning.body.model_config.key, 'Qwen3.8-Thinking');
  assert.equal(reasoning.body.model_config.is_reasoning, true);
});

test('buildQoderHttpRequestBody rejects requests without a conversational message', () => {
  assert.throws(
    () => buildQoderHttpRequestBody({ messages: [{ role: 'system', content: 'sys' }] }, { provider: 'qoder' }),
    (error) => error.code === 'qoder_http_prompt_required'
  );
});

test('normalizeQoderHttpTools keeps only valid function tools', () => {
  const tools = normalizeQoderHttpTools([
    { type: 'function', function: { name: 'ok', description: 'ok' } },
    { type: 'web_search_preview' },
    { type: 'function', function: { name: 'bad name', description: 'bad' } },
    { name: 'legacy', description: 'legacy', input_schema: { type: 'object' } },
    null
  ]);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].function.parameters.type, 'object');
  assert.equal(tools[1].function.name, 'legacy');
  assert.equal(tools[1].function.parameters.type, 'object');
});

test('parseQoderSseEnvelope unwraps chunks, timing, done and errors', () => {
  const chunk = parseQoderSseEnvelope(envelope({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }]
  }));
  assert.equal(chunk.kind, 'chunk');
  assert.equal(chunk.chunk.id, 'chatcmpl-1');
  assert.match(chunk.raw, /chatcmpl-1/);

  const timing = parseQoderSseEnvelope(JSON.stringify({
    firstTokenDuration: 123,
    totalDuration: 456,
    serverDuration: 7
  }));
  assert.deepEqual(timing, {
    kind: 'timing',
    timing: { firstTokenDuration: 123, totalDuration: 456, serverDuration: 7 }
  });

  assert.deepEqual(parseQoderSseEnvelope('[DONE]'), { kind: 'done' });
  assert.deepEqual(parseQoderSseEnvelope(envelope('[DONE]')), { kind: 'done' });

  const failed = parseQoderSseEnvelope(envelope('upstream exploded', 500));
  assert.equal(failed.kind, 'error');
  assert.equal(failed.error.code, 'qoder_http_upstream_error');
  assert.equal(failed.error.statusCode, 500);

  const plainText = parseQoderSseEnvelope('agent_router msg:None flow nodes found');
  assert.equal(plainText.kind, 'error');
  assert.equal(plainText.error.code, 'qoder_http_invalid_chunk');

  const innerError = parseQoderSseEnvelope(envelope({ error: { message: 'bad model' } }));
  assert.equal(innerError.kind, 'error');
  assert.match(innerError.error.message, /bad model/);
});

test('createQoderSsePump reassembles frames split across byte chunks and CRLF', () => {
  const pump = createQoderSsePump();
  const text = 'data: a\r\n\r\ndata: b\n\ndata: c';
  const blocks = [];
  for (let index = 0; index < text.length; index += 1) {
    blocks.push(...pump.push(Buffer.from(text[index])));
  }
  blocks.push(...pump.end());
  assert.deepEqual(blocks, ['data: a', 'data: b', 'data: c']);
  assert.equal(readSseBlockData(blocks[0]), 'a');
});

test('aggregateQoderHttpChunks merges content, reasoning and tool call deltas', () => {
  const payload = aggregateQoderHttpChunks([
    {
      id: 'chatcmpl-1',
      created: 42,
      model: 'auto',
      choices: [{ index: 0, delta: { role: 'assistant', content: '答' }, finish_reason: null }]
    },
    {
      choices: [{ index: 0, delta: { content: '案', reasoning_content: '想' }, finish_reason: null }]
    },
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path"' } }]
        },
        finish_reason: null
      }]
    },
    {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: ':"/tmp/a"}' } }] },
        finish_reason: 'tool_calls'
      }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
    }
  ], { model: 'auto' });

  assert.equal(payload.id, 'chatcmpl-1');
  assert.equal(payload.created, 42);
  assert.equal(payload.model, 'auto');
  assert.equal(payload.choices[0].message.content, '答案');
  assert.equal(payload.choices[0].message.reasoning_content, '想');
  assert.equal(payload.choices[0].message.tool_calls.length, 1);
  assert.equal(payload.choices[0].message.tool_calls[0].function.name, 'read_file');
  assert.equal(payload.choices[0].message.tool_calls[0].function.arguments, '{"path":"/tmp/a"}');
  assert.equal(payload.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(payload.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
});

test('resolveQoderClientVersion reads the version from the binary path', () => {
  assert.equal(resolveQoderClientVersion('/x/qoderclicn-1.1.72', 'qodercn'), '1.1.72');
  assert.equal(resolveQoderClientVersion('/x/no-version', 'qodercn'), '1.1.72');
  assert.equal(resolveQoderClientVersion('/x/no-version', 'qoder'), '1.1.73');
});

test('fetchQoderHttpChatCompletionStream signs, sends zstd body and forwards inner SSE chunks', async () => {
  const requests = [];
  const events = [
    envelope({
      id: 'chatcmpl-stream-1',
      object: 'chat.completion.chunk',
      created: 100,
      model: 'auto',
      choices: [{ index: 0, delta: { role: 'assistant', content: '你' }, finish_reason: null }]
    }),
    envelope({
      id: 'chatcmpl-stream-1',
      choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }]
    }),
    envelope({
      id: 'chatcmpl-stream-1',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    }),
    JSON.stringify({ firstTokenDuration: 88, totalDuration: 199, serverDuration: 6 }),
    envelope('[DONE]')
  ];
  const streamText = sseText(events);
  const fakeFetch = async (url, options) => {
    requests.push({ url, options });
    const bytes = Buffer.from(streamText, 'utf8');
    const stream = new ReadableStream({
      start(controller) {
        // 按 7 字节切，故意把多字节中文与 SSE 分隔符切开。
        for (let index = 0; index < bytes.length; index += 7) {
          controller.enqueue(bytes.subarray(index, index + 7));
        }
        controller.close();
      }
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream;charset=UTF-8' } });
  };
  const dispatcher = { fake: true };
  const signed = [];
  const stream = await fetchQoderHttpChatCompletionStream(
    { aiHomeDir: '/tmp/aih-home', hostHomeDir: '/tmp/aih-host' },
    { provider: 'qodercn', accountRef: 'acct_test' },
    {
      model: 'Qwen3.8-Flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object' } } }]
    },
    120000,
    {
      resolveQoderHttpInvocation: () => ({
        runtimeDir: '/tmp/aih-host/.ai_home/run/auth-projections/qodercn/acct_test',
        cliPath: '/tmp/x/qoderclicn-1.1.72',
        cwd: '/tmp/aih-host'
      }),
      signQoderRequest: (input) => {
        signed.push(input);
        return {
          url: 'https://example.test/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1',
          headers: { 'Content-Type': 'application/json', 'X-Signature': 'test' },
          body: input.bodyJson
        };
      },
      fetchQoderHttp: fakeFetch,
      compressQoderBody: (body) => Buffer.from(body, 'utf8'),
      qoderHttpDispatcher: dispatcher
    }
  );

  assert.equal(stream.streamTransport, 'qoder_http_sse');
  assert.equal(stream.egress, 'injected');
  assert.equal(stream.usageMessageId, 'chatcmpl-stream-1');
  assert.equal(stream.firstTokenMs >= 0, true);
  const bodyText = await waitForBody(stream.body);
  // 上游分片把模型归一成 auto；流式输出必须改回客户端请求的模型，和非流式一致。
  assert.match(bodyText, /"model":"Qwen3\.8-Flash"/);
  assert.doesNotMatch(bodyText, /"model":"auto"/);
  assert.match(bodyText, /"content":"你"/);
  assert.match(bodyText, /"content":"好"/);
  assert.match(bodyText, /"finish_reason":"stop"/);
  assert.match(bodyText, /"usage":\{"prompt_tokens":3/);
  assert.equal(bodyText.trim().endsWith('data: [DONE]'), true);
  assert.deepEqual(stream.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  assert.deepEqual(stream.timing, { firstTokenDuration: 88, totalDuration: 199, serverDuration: 6 });
  assert.equal(stream.error, null);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.dispatcher, dispatcher);
  assert.equal(requests[0].options.headers['Content-Encoding'], 'zstd');
  assert.equal(requests[0].options.headers['X-Signature'], 'test');
  const sentBody = JSON.parse(requests[0].options.body.toString('utf8'));
  assert.equal(sentBody.session_type, 'qoderclicn');
  assert.equal(sentBody.messages[1].content, 'hi');
  assert.equal(sentBody.tools[0].function.name, 'read');
  assert.equal(signed.length, 1);
  assert.equal(signed[0].modelKey, 'Qwen3.8-Flash');
  assert.equal(signed[0].machineToken, '');
});

test('fetchQoderHttpChatCompletion aggregates the streamed chunks into a chat.completion payload', async () => {
  const streamText = sseText([
    envelope({
      id: 'chatcmpl-nonstream-1',
      created: 200,
      model: 'auto',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }]
    }),
    envelope({
      id: 'chatcmpl-nonstream-1',
      choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 }
    }),
    envelope('[DONE]')
  ]);
  const fakeFetch = async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(streamText, 'utf8'));
        controller.close();
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
  const payload = await fetchQoderHttpChatCompletion(
    { aiHomeDir: '/tmp/aih-home', hostHomeDir: '/tmp/aih-host' },
    { provider: 'qoder', accountRef: 'acct_test' },
    { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    120000,
    {
      resolveQoderHttpInvocation: () => ({
        runtimeDir: '/tmp/aih-host/.ai_home/run/auth-projections/qoder/acct_test',
        cliPath: '/tmp/x/qodercli-1.1.73',
        cwd: '/tmp/aih-host'
      }),
      signQoderRequest: () => ({
        url: 'https://example.test/sse',
        headers: {},
        body: '{"x":1}'
      }),
      fetchQoderHttp: fakeFetch,
      compressQoderBody: () => Buffer.from('zstd'),
      qoderHttpDispatcher: {}
    }
  );
  assert.equal(payload.object, 'chat.completion');
  assert.equal(payload.id, 'chatcmpl-nonstream-1');
  assert.equal(payload.model, 'auto');
  assert.equal(payload.choices[0].message.content, 'hello world');
  assert.equal(payload.choices[0].finish_reason, 'stop');
  assert.deepEqual(payload.usage, { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 });
  assert.equal(payload.usageMessageId, 'chatcmpl-nonstream-1');
});

test('fetchQoderHttpChatCompletionStream throws before first chunk when the upstream errors', async () => {
  const fakeFetch = async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(sseText([envelope('quota wall', 403)]), 'utf8'));
        controller.close();
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
  await assert.rejects(
    () => fetchQoderHttpChatCompletionStream(
      { aiHomeDir: '/tmp/aih-home', hostHomeDir: '/tmp/aih-host' },
      { provider: 'qodercn', accountRef: 'acct_test' },
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      1000,
      {
        resolveQoderHttpInvocation: () => ({
          runtimeDir: '/tmp/rt',
          cliPath: '/tmp/x/qoderclicn-1.1.72',
          cwd: '/tmp'
        }),
        signQoderRequest: () => ({ url: 'https://example.test/sse', headers: {}, body: '{}' }),
        fetchQoderHttp: fakeFetch,
        compressQoderBody: () => Buffer.from('zstd'),
        qoderHttpDispatcher: {}
      }
    ),
    (error) => error.code === 'qoder_http_upstream_error' && error.statusCode === 403
  );
});

test('fetchQoderHttpChatCompletionStream retries directly when an env proxy is unreachable', async () => {
  const oldProxy = process.env.HTTPS_PROXY;
  const oldNoProxy = process.env.NO_PROXY;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  delete process.env.NO_PROXY;
  try {
    const streamText = sseText([
      envelope({
        id: 'chatcmpl-direct-1',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }),
      envelope('[DONE]')
    ]);
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('proxy connect ECONNREFUSED');
        error.code = 'ECONNREFUSED';
        throw error;
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from(streamText, 'utf8'));
            controller.close();
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    };
    const stream = await fetchQoderHttpChatCompletionStream(
      { aiHomeDir: '/tmp/aih-home', hostHomeDir: '/tmp/aih-host' },
      { provider: 'qodercn', accountRef: 'acct_test' },
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      120000,
      {
        resolveQoderHttpInvocation: () => ({
          runtimeDir: '/tmp/rt',
          cliPath: '/tmp/x/qoderclicn-1.1.72',
          cwd: '/tmp'
        }),
        signQoderRequest: () => ({ url: 'https://gateway.qoder.com.cn/sse', headers: {}, body: '{}' }),
        fetchQoderHttp: fakeFetch,
        compressQoderBody: () => Buffer.from('zstd'),
        fs: {
          statSync: () => ({ size: 1, mtimeMs: 1 }),
          readFileSync: (file) => {
            if (String(file).endsWith('dns-cache.json')) {
              return JSON.stringify({
                version: 1,
                accounts: { a: { 'gateway.qoder.com.cn': { ips: ['127.0.0.1'], timestamp: 1, ttl: 60 } } }
              });
            }
            throw new Error('missing');
          }
        },
        qoderHttpDispatcher: undefined
      }
    );
    assert.equal(calls, 2);
    assert.equal(stream.egress, 'direct_ip');
    assert.equal(stream.proxyFallback, true);
    const text = await waitForBody(stream.body);
    assert.match(text, /"content":"ok"/);
  } finally {
    if (oldProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = oldProxy;
    if (oldNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = oldNoProxy;
  }
});
