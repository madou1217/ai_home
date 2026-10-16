const test = require('node:test');
const assert = require('node:assert/strict');

const transport = require('../lib/server/kiro-chat-transport');
const {
  encodeKiroEventStreamFrame,
  encodeKiroAssistantEvent,
  encodeKiroInitialResponse
} = require('./helpers/kiro-event-stream-encoder');

function toWebStream(buffer) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    }
  });
}

function fakeResponse(frames, { status = 200 } = {}) {
  return {
    status,
    body: toWebStream(Buffer.concat(frames)),
    async text() {
      return Buffer.concat(frames).toString('utf8');
    },
    async arrayBuffer() {
      return Buffer.concat(frames);
    }
  };
}

test('supportsKiroChatTransport matches only kiro', () => {
  assert.equal(transport.supportsKiroChatTransport('kiro'), true);
  assert.equal(transport.supportsKiroChatTransport('KIRO'), true);
  assert.equal(transport.supportsKiroChatTransport('qoder'), false);
  assert.equal(transport.supportsKiroChatTransport(''), false);
});

test('resolveKiroChatEndpoint prefers the CodeWhisperer RPC host over the legacy q.* host', () => {
  assert.equal(transport.resolveKiroChatEndpoint({}), 'https://codewhisperer.us-east-1.amazonaws.com/');
  assert.equal(
    transport.resolveKiroChatEndpoint({ kiroRegion: 'eu-west-1' }),
    'https://codewhisperer.eu-west-1.amazonaws.com/'
  );
  // 旧默认值（Amazon Q 的其它面）不是 chat 端点：账号里存着它也一律改回 CodeWhisperer。
  assert.equal(
    transport.resolveKiroChatEndpoint({ openaiBaseUrl: 'https://q.us-east-1.amazonaws.com' }),
    'https://codewhisperer.us-east-1.amazonaws.com/'
  );
  assert.equal(
    transport.resolveKiroChatEndpoint({ openaiBaseUrl: 'https://kiro.internal.example/v1/' }),
    'https://kiro.internal.example/v1/'
  );
});

test('buildKiroConversationState folds system prompts and splits history from the current turn', () => {
  const state = transport.buildKiroConversationState({
    model: 'claude-haiku-4.5',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' }
    ]
  }, { conversationId: 'conv-1' });
  assert.equal(state.chatTriggerType, 'MANUAL');
  assert.equal(state.conversationId, 'conv-1');
  assert.equal(state.currentMessage.userInputMessage.content, '第二问');
  assert.equal(state.currentMessage.userInputMessage.modelId, 'claude-haiku-4.5');
  assert.equal(state.history.length, 2);
  assert.equal(state.history[0].userInputMessage.content, '你是助手\n\n第一问');
  assert.equal(state.history[1].assistantResponseMessage.content, '第一答');
});

test('buildKiroConversationState omits empty history and appends a user turn when the last turn is assistant', () => {
  const first = transport.buildKiroConversationState({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'history'), false);
  const trailingAssistant = transport.buildKiroConversationState({
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]
  });
  assert.equal(trailingAssistant.currentMessage.userInputMessage.content, 'Continue.');
  assert.equal(trailingAssistant.history.length, 2);
  assert.equal(trailingAssistant.history[0].userInputMessage.content, 'hi');
  assert.equal(trailingAssistant.history[1].assistantResponseMessage.content, 'hello');
});

test('capacity notice detection is prefix-based so normal answers stream immediately', () => {
  const notice = "We're currently experiencing high demand, which may cause temporary errors.";
  assert.equal(transport.isKiroCapacityNotice(notice), true);
  assert.equal(transport.isKiroCapacityNotice(`回答：${notice}`), true);
  assert.equal(transport.isKiroCapacityNotice('1+1 等于 2'), false);
  // 前缀：仍可能是提示 → 继续攒；一旦偏离 → 立即放行。
  assert.equal(transport.isKiroCapacityNoticePrefix("We're currently"), true);
  assert.equal(transport.isKiroCapacityNoticePrefix('1+1'), false);
});

test('mapKiroUpstreamError maps credential / throttle / capacity to actionable status codes', () => {
  assert.deepEqual(
    transport.mapKiroUpstreamError({
      exceptionType: 'ValidationException',
      payload: JSON.stringify({ message: 'The provided credential is invalid.' })
    }),
    { code: 'kiro_credential_invalid', message: 'The provided credential is invalid.', statusCode: 401 }
  );
  assert.equal(
    transport.mapKiroUpstreamError({ exceptionType: 'ThrottlingException', payload: '{}' }).statusCode,
    429
  );
  assert.equal(
    transport.mapKiroUpstreamError({
      exceptionType: '',
      payload: JSON.stringify({ message: "We're currently experiencing high demand, which may cause temporary errors." })
    }).code,
    'kiro_upstream_capacity'
  );
  assert.equal(
    transport.mapKiroUpstreamError({ exceptionType: 'SomeOtherThing', payload: '{}' }).statusCode,
    502
  );
});

test('runKiroTurn posts the CodeWhisperer streaming request and reassembles the event stream', async () => {
  const calls = [];
  const body = Buffer.concat([
    encodeKiroInitialResponse('conv-abc'),
    encodeKiroAssistantEvent('1+1'),
    encodeKiroAssistantEvent(' 等于 2')
  ]);
  const deltas = [];
  const result = await transport.runKiroTurn({}, { accessToken: 'tok', kiroRegion: 'us-east-1' }, {
    model: 'claude-haiku-4.5',
    messages: [{ role: 'user', content: '帮我算 1+1' }]
  }, 5000, {
    fetch: async (url, init) => {
      calls.push({ url, init });
      // 模拟网络分块：每 7 字节一块，验证增量解析（一帧会被劈开）。
      const chunks = [];
      for (let offset = 0; offset < body.length; offset += 7) chunks.push(body.subarray(offset, offset + 7));
      return {
        status: 200,
        body: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
            controller.close();
          }
        })
      };
    }
  }, (delta) => deltas.push(delta));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://codewhisperer.us-east-1.amazonaws.com/');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/x-amz-json-1.0');
  assert.equal(calls[0].init.headers['x-amz-target'], 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.conversationState.currentMessage.userInputMessage.content, '帮我算 1+1');
  assert.equal(sent.conversationState.currentMessage.userInputMessage.modelId, 'claude-haiku-4.5');
  assert.equal(Object.prototype.hasOwnProperty.call(sent.conversationState, 'history'), false);

  assert.deepEqual(deltas, ['1+1', ' 等于 2']);
  assert.equal(result.content, '1+1 等于 2');
  assert.equal(result.conversationId, 'conv-abc');
  // 上游不给 token 用量 → 估算值必须存在且自洽（sourceKind 由 transport 策略标注 estimated）。
  assert.ok(result.usage.total_tokens > 0);
  assert.equal(result.usage.total_tokens, result.usage.prompt_tokens + result.usage.completion_tokens);
});

test('runKiroTurn includes profileArn when the credential carries one', async () => {
  let sent = null;
  await transport.runKiroTurn({}, { accessToken: 'tok', profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/P' }, {
    model: 'claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'hi' }]
  }, 5000, {
    fetch: async (_url, init) => {
      sent = JSON.parse(init.body);
      return fakeResponse([encodeKiroAssistantEvent('ok')]);
    }
  });
  assert.equal(sent.profileArn, 'arn:aws:codewhisperer:us-east-1:1:profile/P');
});

test('runKiroTurn surfaces exception frames as classified kiro errors', async () => {
  await assert.rejects(
    () => transport.runKiroTurn({}, { accessToken: 'tok' }, { messages: [{ role: 'user', content: 'hi' }] }, 5000, {
      fetch: async () => fakeResponse([
        encodeKiroEventStreamFrame(
          { ':message-type': 'exception', ':exception-type': 'ValidationException' },
          { message: 'The provided credential is invalid.' }
        )
      ])
    }),
    (error) => {
      assert.equal(error.code, 'kiro_credential_invalid');
      assert.equal(error.kiroStatusCode, 401);
      return true;
    }
  );
});


test('runKiroTurn treats a capacity notice served as content as an upstream failure', async () => {
  const notice = "We're currently experiencing high demand, which may cause temporary errors.";
  await assert.rejects(
    () => transport.runKiroTurn({}, { accessToken: 'tok' }, { messages: [{ role: 'user', content: 'hi' }] }, 5000, {
      fetch: async () => fakeResponse([encodeKiroAssistantEvent(notice)])
    }),
    (error) => {
      assert.equal(error.code, 'kiro_upstream_capacity');
      assert.equal(error.kiroStatusCode, 503);
      return true;
    }
  );
});

test('runKiroTurn maps a non-200 credential rejection and a missing token', async () => {
  await assert.rejects(
    () => transport.runKiroTurn({}, { accessToken: 'tok' }, { messages: [{ role: 'user', content: 'hi' }] }, 5000, {
      fetch: async () => fakeResponse(
        [Buffer.from(JSON.stringify({ __type: 'ValidationException', message: 'The provided credential is invalid.' }), 'utf8')],
        { status: 400 }
      )
    }),
    (error) => {
      assert.equal(error.code, 'kiro_credential_invalid');
      assert.equal(error.kiroStatusCode, 401);
      return true;
    }
  );
  await assert.rejects(
    () => transport.runKiroTurn({}, {}, { messages: [{ role: 'user', content: 'hi' }] }, 5000, {
      fetch: async () => fakeResponse([encodeKiroAssistantEvent('x')])
    }),
    { code: 'kiro_missing_access_token' }
  );
});

test('fetchKiroChatCompletion returns an OpenAI chat completion payload', async () => {
  const payload = await transport.fetchKiroChatCompletion({}, { accessToken: 'tok' }, {
    model: 'claude-haiku-4.5',
    messages: [{ role: 'user', content: '说 pong' }]
  }, 5000, {
    fetch: async () => fakeResponse([encodeKiroInitialResponse('conv-9'), encodeKiroAssistantEvent('pong')])
  });
  assert.equal(payload.object, 'chat.completion');
  assert.equal(payload.model, 'claude-haiku-4.5');
  assert.equal(payload.choices[0].message.content, 'pong');
  assert.equal(payload.choices[0].finish_reason, 'stop');
  assert.equal(payload.session_id, 'conv-9');
  assert.ok(payload.usage.total_tokens > 0);
});

test('fetchKiroChatCompletionStream emits OpenAI chat SSE chunks', async () => {
  const upstream = await transport.fetchKiroChatCompletionStream({}, { accessToken: 'tok' }, {
    model: 'claude-haiku-4.5',
    messages: [{ role: 'user', content: 'hi' }]
  }, 5000, {
    fetch: async () => fakeResponse([
      encodeKiroInitialResponse('conv-s'),
      encodeKiroAssistantEvent('po'),
      encodeKiroAssistantEvent('ng')
    ])
  });
  let text = '';
  for await (const chunk of upstream.body) text += chunk.toString('utf8');
  const payloads = text.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .filter((value) => value !== '[DONE]')
    .map((value) => JSON.parse(value));
  assert.equal(payloads[0].object, 'chat.completion.chunk');
  assert.deepEqual(payloads[0].choices[0].delta, { role: 'assistant' });
  assert.deepEqual(payloads.slice(1, 3).map((item) => item.choices[0].delta.content), ['po', 'ng']);
  const last = payloads[payloads.length - 1];
  assert.equal(last.choices[0].finish_reason, 'stop');
  assert.equal(last.session_id, 'conv-s');
  assert.ok(text.endsWith('data: [DONE]\n\n'));
});

test('fetchKiroChatCompletionStream destroys the stream on upstream failure', async () => {
  const upstream = await transport.fetchKiroChatCompletionStream({}, { accessToken: 'tok' }, {
    model: 'claude-haiku-4.5',
    messages: [{ role: 'user', content: 'hi' }]
  }, 5000, {
    fetch: async () => fakeResponse([
      encodeKiroEventStreamFrame({ ':message-type': 'exception', ':exception-type': 'ThrottlingException' }, {})
    ])
  });
  await assert.rejects(async () => {
    for await (const _chunk of upstream.body) { /* drain */ }
  }, (error) => {
    assert.equal(error.code, 'kiro_upstream_throttled');
    return true;
  });
});

