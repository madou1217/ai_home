'use strict';

// 回归守卫（2026-11-01 真机事故）：
//   aih gemini 启动的 Vertex 账号只拿到 API Key，没拿到 GOOGLE_VERTEX_BASE_URL，
//   gemini CLI 按 settings.json 里持久化的 selectedType=vertex-ai 直打
//   aiplatform.googleapis.com → 401「API keys are not supported by this API」。
//   账号库存的是 AIH 自己的键，CLI 只认 GOOGLE_*，两条启动路径都必须做同一份映射。

const test = require('node:test');
const assert = require('node:assert/strict');

const { geminiCliEndpointEnv } = require('../lib/runtime/gemini-endpoint-env');
const { buildProviderRuntimeEnv } = require('../lib/cli/services/ai-cli/provider-runtime-env');

const VERTEX_GATEWAY_ENV = Object.freeze({
  VERTEX_AI_PROJECT_ID: 'vertex-placeholder-project',
  VERTEX_AI_LOCATION: 'global',
  VERTEX_AI_PLACEHOLDER: 'true',
  GEMINI_API_KEY: 'aih_client_test',
  GOOGLE_API_KEY: 'aih_client_test',
  GEMINI_BASE_URL: 'http://127.0.0.1:9527'
});

test('Vertex 占位账号：两个 base URL 都给，占位项目不下发', () => {
  const env = geminiCliEndpointEnv(VERTEX_GATEWAY_ENV);
  assert.equal(env.GOOGLE_GENAI_USE_VERTEXAI, 'true');
  assert.equal(env.GOOGLE_VERTEX_BASE_URL, 'http://127.0.0.1:9527');
  // 2026-11-03 真机：express 账号实际走 API-key 分支，只认 GOOGLE_GEMINI_BASE_URL。
  // 只给 VERTEX 时请求绕过网关直打 Google（400 API key not valid）。
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:9527');
  // express 模式不能带项目/地域，否则 SDK 改走 ADC。
  assert.equal(env.GOOGLE_CLOUD_PROJECT, undefined);
  assert.equal(env.GOOGLE_CLOUD_LOCATION, undefined);
});

test('Vertex 账号：真实项目/地域透传', () => {
  const env = geminiCliEndpointEnv({
    VERTEX_AI_PROJECT_ID: 'my-project',
    VERTEX_AI_LOCATION: 'asia-east1',
    GEMINI_BASE_URL: 'https://us-central1-aiplatform.googleapis.com'
  });
  assert.equal(env.GOOGLE_GENAI_USE_VERTEXAI, 'true');
  assert.equal(env.GOOGLE_VERTEX_BASE_URL, 'https://us-central1-aiplatform.googleapis.com');
  // 真实 project 账号 authType=vertex-ai，不会读 GOOGLE_GEMINI_BASE_URL；
  // 给它会让人误以为「两个都能用」，所以只下发 VERTEX。
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, undefined);
  assert.equal(env.GOOGLE_CLOUD_PROJECT, 'my-project');
  assert.equal(env.GOOGLE_CLOUD_LOCATION, 'asia-east1');
});

test('API Key 账号：base URL 映射到 GOOGLE_GEMINI_BASE_URL，不进 Vertex', () => {
  const env = geminiCliEndpointEnv({ GEMINI_API_KEY: 'k', GEMINI_BASE_URL: 'http://127.0.0.1:9527' });
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:9527');
  assert.equal(env.GOOGLE_GENAI_USE_VERTEXAI, undefined);
  assert.equal(env.GOOGLE_VERTEX_BASE_URL, undefined);
});

test('OAuth 账号：没有接入点字段就不改环境', () => {
  assert.deepEqual(geminiCliEndpointEnv({}), {});
});

test('原生 CLI 启动路径（buildProviderRuntimeEnv）同样完成映射', () => {
  const env = buildProviderRuntimeEnv('gemini', '/tmp', {}, {
    accountEnv: VERTEX_GATEWAY_ENV,
    accountRef: 'acct_test'
  });
  assert.equal(env.GOOGLE_GENAI_USE_VERTEXAI, 'true');
  assert.equal(env.GOOGLE_VERTEX_BASE_URL, 'http://127.0.0.1:9527');
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:9527');
  assert.equal(env.GOOGLE_API_KEY, 'aih_client_test');
  assert.equal(env.GOOGLE_CLOUD_PROJECT, undefined);
});
