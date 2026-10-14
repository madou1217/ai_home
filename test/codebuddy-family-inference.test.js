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

test('buildCodebuddyFamilyUpstreamHeaders carries the client UA and the station origin', () => {
  const headers = buildCodebuddyFamilyUpstreamHeaders('workbuddycn', null);
  assert.equal(headers.origin, 'https://copilot.tencent.com');
  assert.equal(headers.referer, 'https://copilot.tencent.com/');
  assert.equal(headers['x-requested-with'], 'XMLHttpRequest');
  // 国内站网关对脚本 UA 返回 403 code 10085，UA 是必需项而不是装饰。
  assert.match(headers['user-agent'], /CodeBuddy/);
  // authorization 由通用直通链路统一写，这里不重复设置以免两处口径分叉。
  assert.equal(headers.authorization, undefined);
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
