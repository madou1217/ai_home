'use strict';

// CodeBuddy / WorkBuddy 家族推理契约的回归测试。
//
// 夹具取自 2026-10-14 对真实上游的实测响应（探针只输出形状，不含 token）：
//   - 非流式被拒：400 {"code":11101,"msg":"Non-stream chat request is currently not supported"}
//   - 首条非 system：400 {"code":11128,"msg":"first message is not system prompt",...}
//   - 成功流：标准 OpenAI chat.completion.chunk，末尾 data: [DONE]
// 这些断言守住的正是「上游报错文案不会告诉你是哪条约束」的那几条硬约束。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CODEBUDDY_FAMILY_CHAT_PATH,
  resolveCodebuddyFamilyInferenceBaseUrl,
  resolveCodebuddyFamilyOrigin,
  resolveCodebuddyFamilyInferencePath,
  buildCodebuddyFamilyUpstreamHeaders,
  buildCodebuddyFamilyConversationHeaders,
  createCodebuddyFamilyConversationId,
  adaptCodebuddyFamilyChatRequest,
  aggregateCodebuddyFamilySse,
  parseCodebuddyFamilyError
} = require('../lib/account/codebuddy-family-inference');

test('resolveCodebuddyFamilyInferenceBaseUrl maps each family member to its station host', () => {
  assert.equal(resolveCodebuddyFamilyInferenceBaseUrl('codebuddy', null), 'https://www.codebuddy.ai');
  assert.equal(resolveCodebuddyFamilyInferenceBaseUrl('workbuddy', null), 'https://www.workbuddy.ai');
  assert.equal(resolveCodebuddyFamilyInferenceBaseUrl('codebuddycn', null), 'https://copilot.tencent.com');
  assert.equal(resolveCodebuddyFamilyInferenceBaseUrl('workbuddycn', null), 'https://copilot.tencent.com');
});

test('resolveCodebuddyFamilyInferenceBaseUrl prefers the account override and strips trailing slashes', () => {
  assert.equal(
    resolveCodebuddyFamilyInferenceBaseUrl('codebuddy', { openaiBaseUrl: 'https://relay.internal/v1//' }),
    'https://relay.internal/v1'
  );
  assert.equal(
    resolveCodebuddyFamilyInferenceBaseUrl('workbuddycn', { baseUrl: 'https://mirror.example' }),
    'https://mirror.example'
  );
});

test('resolveCodebuddyFamilyInferenceBaseUrl returns empty for providers outside the family', () => {
  for (const provider of ['qoder', 'codex', 'claude', 'kimi', '']) {
    assert.equal(resolveCodebuddyFamilyInferenceBaseUrl(provider, null), '', provider);
  }
});

test('resolveCodebuddyFamilyOrigin keeps scheme and host, dropping any path', () => {
  assert.equal(resolveCodebuddyFamilyOrigin('codebuddy', null), 'https://www.codebuddy.ai');
  assert.equal(
    resolveCodebuddyFamilyOrigin('codebuddy', { openaiBaseUrl: 'https://relay.internal:8443/v1' }),
    'https://relay.internal:8443'
  );
});

test('resolveCodebuddyFamilyInferencePath lifts the client /v1 chat path to the upstream /v2 path', () => {
  // 实测：上游 /v1/chat/completions 是 404 Route Not Found，只有 /v2 存在。
  assert.equal(resolveCodebuddyFamilyInferencePath('codebuddy', '/v1/chat/completions'), CODEBUDDY_FAMILY_CHAT_PATH);
  assert.equal(resolveCodebuddyFamilyInferencePath('workbuddycn', '/chat/completions'), CODEBUDDY_FAMILY_CHAT_PATH);
  assert.equal(
    resolveCodebuddyFamilyInferencePath('workbuddy', '/v1/chat/completions?foo=1'),
    `${CODEBUDDY_FAMILY_CHAT_PATH}?foo=1`
  );
});

test('resolveCodebuddyFamilyInferencePath leaves /v2 and unrelated paths untouched', () => {
  assert.equal(resolveCodebuddyFamilyInferencePath('codebuddy', '/v2/chat/completions'), '/v2/chat/completions');
  assert.equal(resolveCodebuddyFamilyInferencePath('codebuddy', '/v1/models'), '/v1/models');
  assert.equal(resolveCodebuddyFamilyInferencePath('qoder', '/v1/chat/completions'), '/v1/chat/completions');
});

test('buildCodebuddyFamilyUpstreamHeaders reproduces the official CLI identity and omits browser-only headers', () => {
  const headers = buildCodebuddyFamilyUpstreamHeaders('workbuddycn', null);
  assert.equal(headers['x-requested-with'], 'XMLHttpRequest');
  // 国内站网关对脚本 UA 返回 403 code 10085，UA 是必需项而不是装饰。
  assert.match(headers['user-agent'], /^CLI\/[\d.]+ CodeBuddy\/[\d.]+$/);
  // authorization 由通用直通链路统一写，这里不重复设置以免两处口径分叉。
  assert.equal(headers.authorization, undefined);
  // 官方 CLI 身份**不发** Origin / Referer（2026-10-21 抓包确认）：浏览器语义头只有
  // 桌面/VSCode 身份才带，发它们反而是一处与官方不符的差异。
  assert.equal(headers.origin, undefined);
  assert.equal(headers.referer, undefined);
  // 官方身份头（实测不参与渠道校验，发它们只为让请求画像与官方一致）。
  assert.equal(headers['x-product'], 'SaaS');
  assert.equal(headers['x-domain'], 'copilot.tencent.com');
  assert.equal(headers['x-ide-type'], 'CLI');
  assert.equal(headers['x-agent-intent'], 'craft');
  assert.equal(headers['x-codebuddy-request'], '1');
});

test('buildCodebuddyFamilyUpstreamHeaders carries X-User-Id only when a uid is supplied', () => {
  const withUid = buildCodebuddyFamilyUpstreamHeaders('workbuddy', null, { uid: 'uid-1' });
  assert.equal(withUid['x-user-id'], 'uid-1');
  // uid 缺失时不下发空头——留空头比不发更容易被识别为异常。
  const withoutUid = buildCodebuddyFamilyUpstreamHeaders('workbuddy', null);
  assert.equal(withoutUid['x-user-id'], undefined);
});

// 渠道校验（2026-10-21 实测）：会话 ID 家族缺任一个或为空，上游回 400 code 11128
// 「request illegal / 没通过渠道校验」。UA、X-IDE-*、body 形状都不参与这条校验。
test('buildCodebuddyFamilyUpstreamHeaders always carries the non-empty conversation ids required by channel verification', () => {
  for (const provider of ['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']) {
    const headers = buildCodebuddyFamilyUpstreamHeaders(provider, null);
    for (const name of ['x-conversation-id', 'x-conversation-message-id', 'x-conversation-request-id', 'x-request-id']) {
      assert.ok(String(headers[name] || '').trim(), `${provider} 缺少 ${name}`);
      assert.match(headers[name], /^[0-9a-f-]+$/);
    }
  }
});

test('buildCodebuddyFamilyConversationHeaders keeps one conversation id per client session without leaking the session key', () => {
  const first = buildCodebuddyFamilyConversationHeaders('session-abc');
  const second = buildCodebuddyFamilyConversationHeaders('session-abc');
  const other = buildCodebuddyFamilyConversationHeaders('session-xyz');
  // 同一会话 → 同一 conversation id（与官方客户端一致），不同会话不撞。
  assert.equal(first['x-conversation-id'], second['x-conversation-id']);
  assert.notEqual(first['x-conversation-id'], other['x-conversation-id']);
  // 会话键来自客户端，不能原样外发给上游。
  assert.ok(!first['x-conversation-id'].includes('session-abc'));
  // 消息 / 请求级 id 每次都新建。
  assert.notEqual(first['x-conversation-message-id'], second['x-conversation-message-id']);
  assert.notEqual(first['x-conversation-request-id'], second['x-conversation-request-id']);
});

test('buildCodebuddyFamilyConversationHeaders mints a fresh conversation id when there is no session key', () => {
  const a = buildCodebuddyFamilyConversationHeaders('');
  const b = buildCodebuddyFamilyConversationHeaders(undefined);
  assert.ok(a['x-conversation-id']);
  assert.notEqual(a['x-conversation-id'], b['x-conversation-id']);
});

test('createCodebuddyFamilyConversationId is time-ordered and shaped like the official UUIDv7 ids', () => {
  const earlier = createCodebuddyFamilyConversationId(1_000);
  const later = createCodebuddyFamilyConversationId(2_000);
  // 官方形状（2026-10-21 抓包样本 `01a15ede-5927-7289-86f7-0648bbaa2d32`）：
  // 8-4-4-4-12 十六进制，第 13 位版本固定 7、第 17 位变体固定 8。
  assert.match(earlier, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(earlier.replace(/-/g, '').slice(0, 12), (1_000).toString(16).padStart(12, '0'));
  assert.ok(earlier.replace(/-/g, '').slice(0, 12) < later.replace(/-/g, '').slice(0, 12));
});

test('adaptCodebuddyFamilyChatRequest injects a neutral system prompt when the first message is not system', () => {
  const input = { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] };
  const result = adaptCodebuddyFamilyChatRequest(input, { env: {} });
  assert.equal(result.injectedSystemPrompt, true);
  assert.equal(result.body.messages[0].role, 'system');
  assert.equal(result.body.messages[1].content, 'hi');
  // 原对象不得被改动：调用方还要拿它做日志。
  assert.equal(input.messages.length, 1);
  assert.equal(input.messages[0].role, 'user');
});

test('adaptCodebuddyFamilyChatRequest keeps an existing leading system message and honours the env override', () => {
  const withSystem = adaptCodebuddyFamilyChatRequest({
    messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }]
  }, { env: {} });
  assert.equal(withSystem.injectedSystemPrompt, false);
  assert.equal(withSystem.body.messages[0].content, 'be terse');

  const overridden = adaptCodebuddyFamilyChatRequest(
    { messages: [{ role: 'user', content: 'hi' }] },
    { env: { CODEBUDDY_FAMILY_DEFAULT_SYSTEM_PROMPT: 'You are WorkBuddy.' } }
  );
  assert.equal(overridden.body.messages[0].content, 'You are WorkBuddy.');
});

test('adaptCodebuddyFamilyChatRequest always forces stream because the upstream rejects non-stream', () => {
  const result = adaptCodebuddyFamilyChatRequest({ messages: [{ role: 'user', content: 'hi' }], stream: false });
  assert.equal(result.body.stream, true);
  assert.equal(result.streamed, true);
});

test('adaptCodebuddyFamilyChatRequest tolerates a body without messages', () => {
  const result = adaptCodebuddyFamilyChatRequest({});
  assert.equal(result.body.messages.length, 1);
  assert.equal(result.body.messages[0].role, 'system');
});

// 2026-10-14 实测：上游 Go 结构体把 tool_choice 声明成 string，
// 发 object 直接 400「cannot unmarshal object into Go struct field Request.tool_choice of type string」，
// 而 OpenAI 规范与 Cline 等客户端强制工具时发的正是 object。
const FAMILY_TEST_TOOLS = [
  { type: 'function', function: { name: 'get_weather', description: 'w', parameters: {} } },
  { type: 'function', function: { name: 'read_file', description: 'r', parameters: {} } }
];

test('adaptCodebuddyFamilyChatRequest keeps a pinned tool exact by narrowing the tool list', () => {
  const forced = adaptCodebuddyFamilyChatRequest({
    messages: [{ role: 'system', content: 's' }],
    tools: FAMILY_TEST_TOOLS,
    tool_choice: { type: 'function', function: { name: 'get_weather' } }
  });
  // 上游只认字符串，但「钉住某个函数」不能退化成裸 required（那样模型可以改用别的工具甚至改用
  // 散文回答）：把 tools 收窄到被钉的那一个再发 required，此时 required 与「必须调用 get_weather」等价。
  assert.equal(forced.body.tool_choice, 'required');
  assert.equal(forced.body.tools.length, 1);
  assert.equal(forced.body.tools[0].function.name, 'get_weather');
  assert.equal(forced.toolChoiceNormalized, true);
  assert.equal(forced.toolChoicePin, 'get_weather');
  assert.equal(forced.toolChoicePinPreserved, true);
  assert.equal(forced.toolChoicePinMissing, false);
  assert.equal(forced.toolChoiceDowngraded, false);
  // 客户端的工具数组不被就地改写（调用方还要拿原值做日志）。
  assert.equal(FAMILY_TEST_TOOLS.length, 2);
});

test('adaptCodebuddyFamilyChatRequest accepts the Responses flat pin form', () => {
  const forced = adaptCodebuddyFamilyChatRequest({
    messages: [{ role: 'system', content: 's' }],
    tools: FAMILY_TEST_TOOLS,
    tool_choice: { type: 'function', name: 'read_file' }
  });
  assert.equal(forced.body.tool_choice, 'required');
  assert.equal(forced.body.tools.length, 1);
  assert.equal(forced.body.tools[0].function.name, 'read_file');
  assert.equal(forced.toolChoicePinPreserved, true);
});

test('adaptCodebuddyFamilyChatRequest degrades a pin that is not in tools without touching tools', () => {
  const forced = adaptCodebuddyFamilyChatRequest({
    messages: [{ role: 'system', content: 's' }],
    tools: FAMILY_TEST_TOOLS,
    tool_choice: { type: 'function', function: { name: 'nope' } }
  });
  // 目标不在工具集里，只能退化成裸 required —— 但绝不伪造出那个函数。
  assert.equal(forced.body.tool_choice, 'required');
  assert.deepEqual(forced.body.tools, FAMILY_TEST_TOOLS);
  assert.equal(forced.toolChoicePin, 'nope');
  assert.equal(forced.toolChoicePinPreserved, false);
  assert.equal(forced.toolChoicePinMissing, true);
  assert.equal(forced.toolChoiceDowngraded, true);
});

test('adaptCodebuddyFamilyChatRequest drops an unfulfillable pin when there are no tools', () => {
  // 没有工具时发 required 会被上游按「required 却无工具」拒绝，此时只能不约束。
  for (const tools of [undefined, []]) {
    const forced = adaptCodebuddyFamilyChatRequest({
      messages: [{ role: 'system', content: 's' }],
      tools,
      tool_choice: { type: 'function', function: { name: 'get_weather' } }
    });
    assert.equal(Object.hasOwn(forced.body, 'tool_choice'), false, JSON.stringify(tools));
    assert.equal(forced.toolChoicePinMissing, true, JSON.stringify(tools));
    assert.equal(forced.toolChoiceDowngraded, true, JSON.stringify(tools));
  }
});

test('adaptCodebuddyFamilyChatRequest maps the plain object tool_choice forms', () => {
  for (const type of ['auto', 'none', 'required']) {
    const plain = adaptCodebuddyFamilyChatRequest({
      messages: [{ role: 'system', content: 's' }],
      tool_choice: { type }
    });
    assert.equal(plain.body.tool_choice, type, type);
    assert.equal(plain.toolChoiceNormalized, true, type);
    assert.equal(plain.toolChoiceDowngraded, false, type);
  }
  // 没有名字的 function 形态：只能强制一次工具调用，并留痕原始形态。
  const nameless = adaptCodebuddyFamilyChatRequest({
    messages: [{ role: 'system', content: 's' }],
    tools: FAMILY_TEST_TOOLS,
    tool_choice: { type: 'function' }
  });
  assert.equal(nameless.body.tool_choice, 'required');
  assert.equal(nameless.body.tools, FAMILY_TEST_TOOLS);
  assert.equal(nameless.toolChoiceUnsupportedForm, 'function_without_name');
  assert.equal(nameless.toolChoiceDowngraded, true);
});

test('adaptCodebuddyFamilyChatRequest leaves a string tool_choice untouched', () => {
  for (const value of ['auto', 'required', 'none']) {
    const result = adaptCodebuddyFamilyChatRequest({
      messages: [{ role: 'system', content: 's' }],
      tool_choice: value
    });
    assert.equal(result.body.tool_choice, value, value);
    assert.equal(result.toolChoiceNormalized, false, value);
  }
  // 没有 tool_choice 时不得凭空造出字段。
  const absent = adaptCodebuddyFamilyChatRequest({ messages: [{ role: 'system', content: 's' }] });
  assert.equal(Object.hasOwn(absent.body, 'tool_choice'), false);
  assert.equal(absent.toolChoiceNormalized, false);
});

test('adaptCodebuddyFamilyChatRequest relaxes an unrecognized tool_choice instead of forwarding it', () => {
  // 带工具集：放宽成 auto（而不是把 object 原样发上去换一个 400），并记录原始形态。
  for (const [value, form] of [[{ type: 'mystery' }, 'mystery'], [{}, 'unknown'], [[1, 2], 'array'], [42, 'number']]) {
    const result = adaptCodebuddyFamilyChatRequest({
      messages: [{ role: 'system', content: 's' }],
      tools: FAMILY_TEST_TOOLS,
      tool_choice: value
    });
    assert.equal(result.body.tool_choice, 'auto', JSON.stringify(value));
    assert.equal(result.body.tools, FAMILY_TEST_TOOLS, JSON.stringify(value));
    assert.equal(result.toolChoiceNormalized, true, JSON.stringify(value));
    assert.equal(result.toolChoiceDowngraded, true, JSON.stringify(value));
    assert.equal(result.toolChoiceUnsupportedForm, form, JSON.stringify(value));
  }
  // 没有工具集：auto 也没有意义，直接去掉该字段（上游默认即 auto）。
  for (const value of [{ type: 'mystery' }, {}, [1, 2], 42]) {
    const result = adaptCodebuddyFamilyChatRequest({
      messages: [{ role: 'system', content: 's' }],
      tool_choice: value
    });
    assert.equal(Object.hasOwn(result.body, 'tool_choice'), false, JSON.stringify(value));
    assert.equal(result.toolChoiceNormalized, true, JSON.stringify(value));
    assert.equal(result.toolChoiceDowngraded, true, JSON.stringify(value));
  }
});

test('adaptCodebuddyFamilyChatRequest normalizes the accepted string aliases', () => {
  // Mistral 系的 any 与上游 required 严格等价。
  const alias = adaptCodebuddyFamilyChatRequest({
    messages: [{ role: 'system', content: 's' }],
    tool_choice: 'any'
  });
  assert.equal(alias.body.tool_choice, 'required');
  assert.equal(alias.toolChoiceDowngraded, false);
  // 大小写/空白也一并规范，避免上游按未知枚举拒绝。
  const padded = adaptCodebuddyFamilyChatRequest({
    messages: [{ role: 'system', content: 's' }],
    tool_choice: '  AUTO '
  });
  assert.equal(padded.body.tool_choice, 'auto');
  // 认不出的字符串同样是 fail-open，不是 400。
  const unknown = adaptCodebuddyFamilyChatRequest({
    messages: [{ role: 'system', content: 's' }],
    tools: FAMILY_TEST_TOOLS,
    tool_choice: 'sometimes'
  });
  assert.equal(unknown.body.tool_choice, 'auto');
  assert.equal(unknown.toolChoiceUnsupportedForm, 'sometimes');
  assert.equal(unknown.toolChoiceDowngraded, true);
});

test('normalizeCodebuddyFamilyToolChoice keeps the caller body intact', () => {
  const source = {
    messages: [{ role: 'system', content: 's' }],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
    stream: false
  };
  const result = adaptCodebuddyFamilyChatRequest(source);
  assert.equal(result.body.stream, true);
  // 入参不被改写：调用方还要拿原值做日志。
  assert.deepEqual(source.tool_choice, { type: 'function', function: { name: 'get_weather' } });
  assert.equal(source.stream, false);
  assert.notEqual(result.body, source);
});

test('aggregateCodebuddyFamilySse folds upstream chunks into one chat.completion', () => {
  const sse = [
    'data: {"id":"cmb-1","model":"glm-5.2","object":"chat.completion.chunk","created":1791952010,"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":""}],"usage":null}',
    'data: {"id":"cmb-1","model":"glm-5.2","object":"chat.completion.chunk","created":1791952010,"choices":[{"index":0,"delta":{"content":"收"},"finish_reason":""}],"usage":null}',
    'data: {"id":"cmb-1","model":"glm-5.2","object":"chat.completion.chunk","created":1791952010,"choices":[{"index":0,"delta":{"content":"到"},"finish_reason":"stop"}],"usage":{"prompt_tokens":18,"completion_tokens":1,"total_tokens":19}}',
    'data: [DONE]',
    ''
  ].join('\n');
  const { payload, sawDone, sawChunk } = aggregateCodebuddyFamilySse(sse);
  assert.equal(sawDone, true);
  assert.equal(sawChunk, true);
  assert.equal(payload.object, 'chat.completion');
  assert.equal(payload.id, 'cmb-1');
  assert.equal(payload.model, 'glm-5.2');
  assert.equal(payload.choices[0].message.content, '收到');
  assert.equal(payload.choices[0].finish_reason, 'stop');
  assert.equal(payload.usage.total_tokens, 19);
});

test('aggregateCodebuddyFamilySse reports an empty result rather than inventing content', () => {
  const { payload, sawChunk } = aggregateCodebuddyFamilySse('data: [DONE]\n');
  assert.equal(sawChunk, false);
  assert.equal(payload.choices[0].message.content, '');
});

test('aggregateCodebuddyFamilySse ignores malformed lines', () => {
  const { payload } = aggregateCodebuddyFamilySse('data: not-json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n');
  assert.equal(payload.choices[0].message.content, 'ok');
});

// 夹具逐字取自 2026-10-14 的真实上游流（tool_choice=auto + 一个 get_weather 工具）：
// 工具调用走标准 `delta.tool_calls[]`，首帧给 id/name、随后帧给 arguments 分片，
// 同一帧里的 `function_call:{name:'',arguments:''}` 是空占位，末帧 finish_reason=tool_calls。
// 丢掉 tool_calls 会让非流式客户端拿到 finish_reason=tool_calls 却无工具可执行（表现为空回答）。
const REAL_TOOL_CALL_STREAM = [
  'data: {"id":"cmb-tc","model":"hy4-preview","object":"chat.completion.chunk","created":1791992412,"choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"","function_call":null,"refusal":"","tool_calls":[],"extra_fields":null},"logprobs":null,"finish_reason":""}],"usage":null}',
  'data: {"id":"cmb-tc","model":"hy4-preview","object":"chat.completion.chunk","created":1791992412,"choices":[{"index":0,"delta":{"content":"","reasoning_content":"The user wants me to call get_weather for Paris.","function_call":null,"refusal":"","tool_calls":[],"extra_fields":null},"logprobs":null,"finish_reason":""}],"usage":null}',
  'data: {"id":"cmb-tc","model":"hy4-preview","object":"chat.completion.chunk","created":1791992412,"choices":[{"index":0,"delta":{"content":"","tool_calls":[{"id":"chatcmpl-tool-9fc73d84c4849848","type":"function","function":{"name":"get_weather","arguments":""},"index":0}]},"logprobs":null,"finish_reason":""}],"usage":null}',
  'data: {"id":"cmb-tc","model":"hy4-preview","object":"chat.completion.chunk","created":1791992412,"choices":[{"index":0,"delta":{"content":"","tool_calls":[{"function":{"name":"","arguments":"{\\"city\\": \\"Paris\\"}"},"index":0}]},"logprobs":null,"finish_reason":""}],"usage":null}',
  'data: {"id":"cmb-tc","model":"hy4-preview","object":"chat.completion.chunk","created":1791992412,"choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"","function_call":{"name":"","arguments":""},"refusal":"","tool_calls":[],"extra_fields":null},"logprobs":null,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":245,"completion_tokens":78,"total_tokens":323}}',
  'data: [DONE]',
  ''
].join('\n');

test('aggregateCodebuddyFamilySse folds streamed tool_calls into message.tool_calls', () => {
  const { payload } = aggregateCodebuddyFamilySse(REAL_TOOL_CALL_STREAM);
  const message = payload.choices[0].message;
  assert.equal(payload.choices[0].finish_reason, 'tool_calls');
  assert.equal(message.content, '');
  assert.equal(message.tool_calls.length, 1);
  assert.equal(message.tool_calls[0].id, 'chatcmpl-tool-9fc73d84c4849848');
  assert.equal(message.tool_calls[0].type, 'function');
  assert.equal(message.tool_calls[0].function.name, 'get_weather');
  assert.equal(message.tool_calls[0].function.arguments, '{"city": "Paris"}');
  // 非流式 message.tool_calls 不带流式分片序号；空 function_call 占位不得变成字段。
  assert.equal(Object.hasOwn(message.tool_calls[0], 'index'), false);
  assert.equal(message.function_call, undefined);
});

test('aggregateCodebuddyFamilySse keeps parallel tool calls separate and ordered by index', () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"get_time","arguments":""}}]},"finish_reason":""}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\""}}]},"finish_reason":""}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"tz\\":\\"UTC\\"}"}}]},"finish_reason":""}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"Paris\\"}"}}]},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
    ''
  ].join('\n');
  const calls = aggregateCodebuddyFamilySse(sse).payload.choices[0].message.tool_calls;
  assert.deepEqual(calls.map((call) => call.id), ['call_a', 'call_b']);
  assert.deepEqual(calls.map((call) => call.function.name), ['get_weather', 'get_time']);
  assert.deepEqual(calls.map((call) => call.function.arguments), ['{"city":"Paris"}', '{"tz":"UTC"}']);
});

test('aggregateCodebuddyFamilySse surfaces a non-empty legacy function_call only', () => {
  const legacy = aggregateCodebuddyFamilySse([
    'data: {"choices":[{"delta":{"function_call":{"name":"get_weather","arguments":""}},"finish_reason":""}]}',
    'data: {"choices":[{"delta":{"function_call":{"name":"","arguments":"{\\"city\\":\\"Paris\\"}"}},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
    ''
  ].join('\n'));
  assert.deepEqual(legacy.payload.choices[0].message.function_call, {
    name: 'get_weather',
    arguments: '{"city":"Paris"}'
  });
  assert.equal(legacy.payload.choices[0].message.tool_calls, undefined);

  const placeholderOnly = aggregateCodebuddyFamilySse([
    'data: {"choices":[{"delta":{"content":"hi","function_call":{"name":"","arguments":""}},"finish_reason":"stop"}]}',
    'data: [DONE]',
    ''
  ].join('\n'));
  assert.equal(placeholderOnly.payload.choices[0].message.function_call, undefined);
  assert.equal(placeholderOnly.payload.choices[0].message.content, 'hi');
});

test('aggregateCodebuddyFamilySse keeps content alongside tool calls', () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Let me check. "},"finish_reason":""}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"get_weather","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
    ''
  ].join('\n');
  const message = aggregateCodebuddyFamilySse(sse).payload.choices[0].message;
  assert.equal(message.content, 'Let me check. ');
  assert.equal(message.tool_calls[0].function.name, 'get_weather');
});

test('parseCodebuddyFamilyError surfaces the Chinese display message from the Tencent envelope', () => {
  const body = JSON.stringify({
    code: 11128,
    msg: 'first message is not system prompt',
    requestId: 'x',
    displayMsg: { en: 'The request was blocked.', zh: '请求被安全策略拦截，请稍后重试或联系支持。', 'zh-hant': '請求已被…' },
    actions: ['SUBMIT_FEEDBACK']
  });
  const result = parseCodebuddyFamilyError(400, body);
  assert.equal(result.ok, false);
  assert.equal(result.code, 11128);
  assert.equal(result.message, '请求被安全策略拦截，请稍后重试或联系支持。');
  // 该码换账号重试有意义（可能是出口 IP 被拦），所以标成可重试。
  assert.equal(result.retryable, true);
});

test('parseCodebuddyFamilyError treats channel verification (11128) as not retryable but keeps the other 11128 meaning', () => {
  // 渠道校验：请求形态被拦，换号只会拿到同一张拒绝 → 不可重试（与 Go observer 同口径）。
  const channel = parseCodebuddyFamilyError(400, JSON.stringify({
    code: 11128,
    msg: 'request illegal',
    requestId: 'x',
    displayMsg: { en: 'Request blocked. Please send it again', zh: '请求被拦截，请重新发送' },
    displayTips: { en: 'This call failed channel verification, possibly because it was not sent from an official client.' },
    actions: ['EDIT_INPUT', 'SUBMIT_FEEDBACK']
  }));
  assert.equal(channel.ok, false);
  assert.equal(channel.code, 11128);
  assert.equal(channel.message, '请求被拦截，请重新发送');
  assert.equal(channel.retryable, false);

  // 同一个码的另一种语义（首条非 system）：本端应当规避的形态，仍按可重试处理。
  const notSystem = parseCodebuddyFamilyError(400, JSON.stringify({
    code: 11128,
    msg: 'first message is not system prompt'
  }));
  assert.equal(notSystem.retryable, true);
});

test('parseCodebuddyFamilyError falls back to msg then to the status code', () => {
  const msgOnly = parseCodebuddyFamilyError(400, JSON.stringify({ code: 99999, msg: 'boom' }));
  assert.equal(msgOnly.message, 'boom');
  assert.equal(msgOnly.retryable, false);

  const htmlBody = parseCodebuddyFamilyError(401, '<html><head><title>401 Authorization Required</title></head></html>');
  assert.equal(htmlBody.ok, false);
  assert.equal(htmlBody.code, null);
  assert.match(htmlBody.message, /401 Authorization Required/);
});

test('parseCodebuddyFamilyError treats a non-envelope JSON body as not-an-error', () => {
  const result = parseCodebuddyFamilyError(200, JSON.stringify({ error: { message: 'x' } }));
  assert.equal(result.ok, true);
});
