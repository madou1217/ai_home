'use strict';

// 持久别名（WebUI 里配的 model_aliases 表）对 Gemini 原生协议必须生效。
//
// 背景（2026-11-01 真机）：`aih gemini` 的默认模型 `gemini-3.8-flash` 在池里只有 free 档
// 账号，上游一律 11158；给这个名字配了别名改走 codex 中转的 tiered 变体，但请求仍按原模型
// 发出（日志里 requestedModel 与 effectiveModel 一模一样）。原因是别名解析只读请求体的
// `model` 字段，而 Gemini 原生把模型放在 URL 路径上（`/v1beta/models/<model>:generateContent`）。
// 会话级 `--model-alias` 早已覆盖路径（见 session-model-alias-request），两条通道必须同判据。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyAliasPathname,
  resolveModelAliasCandidates,
  resolveModelAliasRequest
} = require('../lib/server/model-alias-resolver');
const { convertGeminiGenerateContentToOpenAIChat } = require('../lib/server/protocol-gemini-request-adapters');

const GEMINI_PATH = '/v1beta/models/gemini-3.8-flash:streamGenerateContent';

function aliases() {
  return [{
    id: 'a1b2c3d4',
    alias: 'gemini-3.8-flash',
    target: 'gemini-3.8-flash-tiered',
    provider: 'all',
    targetProvider: 'codex',
    priority: 0,
    enabled: true
  }];
}

test('别名命中 Gemini 路径里的模型名', () => {
  const context = resolveModelAliasCandidates({
    aliases: aliases(),
    requestJson: { contents: [{ parts: [{ text: 'hi' }] }] },
    pathname: GEMINI_PATH,
    clientProtocol: 'gemini_stream_generate_content'
  });

  assert.equal(context.requestedModel, 'gemini-3.8-flash');
  assert.equal(context.baseProvider, 'gemini');
  assert.equal(context.candidates.length, 1);
  assert.equal(context.candidates[0].target, 'gemini-3.8-flash-tiered');
});

test('命中后请求体里的 model 被换成别名目标', () => {
  const applied = resolveModelAliasRequest({
    aliases: aliases(),
    requestJson: { contents: [] },
    pathname: GEMINI_PATH,
    clientProtocol: 'gemini_stream_generate_content'
  });

  assert.equal(applied.changed, true);
  assert.equal(applied.requestJson.model, 'gemini-3.8-flash-tiered');
  assert.equal(applied.aliasResolution.requestedModel, 'gemini-3.8-flash');
  assert.equal(applied.aliasResolution.effectiveModel, 'gemini-3.8-flash-tiered');
  assert.equal(applied.aliasTargetProvider, 'codex');
});

test('请求体自带 model 时仍以请求体为准（不被路径覆盖）', () => {
  const context = resolveModelAliasCandidates({
    aliases: aliases(),
    requestJson: { model: 'gpt-5.6' },
    // 路径里是另一个名字：正常请求不会这样，这里只证明优先级是「体 > 路径」。
    pathname: GEMINI_PATH,
    clientProtocol: 'gemini_stream_generate_content'
  });

  assert.equal(context.requestedModel, 'gpt-5.6');
  assert.equal(context.candidates.length, 0);
});

test('Vertex 形态的路径（publishers/google/models）同样命中', () => {
  const context = resolveModelAliasCandidates({
    aliases: aliases(),
    requestJson: { contents: [] },
    pathname: '/v1beta1/publishers/google/models/gemini-3.8-flash:streamGenerateContent',
    clientProtocol: 'gemini_stream_generate_content'
  });

  assert.equal(context.requestedModel, 'gemini-3.8-flash');
  assert.equal(context.candidates.length, 1);
});

test('没有别名的模型不受影响', () => {
  const context = resolveModelAliasCandidates({
    aliases: aliases(),
    requestJson: {},
    pathname: '/v1beta/models/gemini-3-flash:generateContent',
    clientProtocol: 'gemini_generate_content'
  });

  assert.equal(context.requestedModel, 'gemini-3-flash');
  assert.equal(context.candidates.length, 0);
});

// 别名命中后必须把模型同步到路径上：协议转换（Gemini → OpenAI/Anthropic）只从 pathname 取模型，
// 只改请求体的 model 会在转换那一步被路径上的原名覆盖。这是 2026-11-01 真机「别名已命中、
// 路由也选了目标 provider，上游收到的却还是原名」的直接原因。
test('别名命中后路径里的模型被换成目标（协议转换只认路径）', () => {
  const applied = resolveModelAliasRequest({
    aliases: aliases(),
    requestJson: { contents: [] },
    pathname: GEMINI_PATH,
    clientProtocol: 'gemini_stream_generate_content'
  });
  const pathname = applyAliasPathname(GEMINI_PATH, applied.aliasResolution);

  assert.equal(pathname, '/v1beta/models/gemini-3.8-flash-tiered:streamGenerateContent');
  const converted = convertGeminiGenerateContentToOpenAIChat(
    { contents: [{ role: 'user', parts: [{ text: 'say ok' }] }] },
    pathname,
    true
  );
  assert.equal(converted.model, 'gemini-3.8-flash-tiered');
});

test('未命中别名时路径保持原样', () => {
  const applied = resolveModelAliasRequest({
    aliases: aliases(),
    requestJson: {},
    pathname: '/v1beta/models/gemini-3-flash:generateContent',
    clientProtocol: 'gemini_generate_content'
  });

  assert.equal(applied.aliasResolution.aliasMatched, false);
  assert.equal(applyAliasPathname('/v1beta/models/gemini-3-flash:generateContent', applied.aliasResolution),
    '/v1beta/models/gemini-3-flash:generateContent');
  assert.equal(applyAliasPathname('/v1/chat/completions', applied.aliasResolution), '/v1/chat/completions');
});
