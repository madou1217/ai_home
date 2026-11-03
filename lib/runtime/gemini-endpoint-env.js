'use strict';

/**
 * gemini 账号库字段 → gemini CLI 实际读取的接入点变量。
 *
 * 账号库存的是 AIH 自己的键（`GEMINI_BASE_URL`；Vertex 账号另存 `VERTEX_AI_PROJECT_ID` /
 * `VERTEX_AI_LOCATION`），而 CLI 只认 `GOOGLE_GEMINI_BASE_URL` / `GOOGLE_VERTEX_BASE_URL` /
 * `GOOGLE_GENAI_USE_VERTEXAI` / `GOOGLE_CLOUD_*`。不映射的话账号配的接入点在启动时全部丢失，
 * CLI 会按自己的默认（本机 settings.json 里持久化的 auth selectedType）直打 Google：
 * Vertex 模式下只带 API Key → 401 `API keys are not supported by this API`。
 *
 * Vertex 账号的 base URL 指向任意实现了 Vertex generateContent 的宿主即可——包括 AIH 网关本身
 * （网关把 /v1[beta1]/[projects/../locations/..]/publishers/google/models/{m}:... 改写成标准
 * Gemini 入口，交给池里能处理 {m} 的账号；见 protocol-registry 的 VERTEX_GEMINI_PATH）。
 * 这样以后有了真正的 Gemini API Key / Vertex 账号，只换 base URL 与密钥即可无缝切换。
 *
 * 两个调用点必须共用这一份实现：服务端 chat（native-session-chat-env）与原生 CLI 启动
 * （cli/services/ai-cli/provider-runtime-env）。2026-11-01 事故：只接了服务端那条，
 * `aih gemini` 启动的 Vertex 账号拿不到 GOOGLE_VERTEX_BASE_URL，请求直打 aiplatform 401。
 */
function geminiCliEndpointEnv(accountEnv = {}) {
  const value = (key) => String(accountEnv[key] || '').trim();
  const env = {};
  const baseUrl = value('GEMINI_BASE_URL');
  const vertex = value('VERTEX_AI_PROJECT_ID') || value('VERTEX_AI_LOCATION')
    || value('GOOGLE_GENAI_USE_VERTEXAI').toLowerCase() === 'true';
  if (vertex) {
    env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
    if (baseUrl) env.GOOGLE_VERTEX_BASE_URL = baseUrl;
    // express（placeholder）账号虽然带 vertex 标记，实际生效的却是 API-key 分支：
    // gemini CLI 的认证路径按 authType 二选一，只认 GOOGLE_GEMINI_BASE_URL。
    // 2026-11-03 真机：只给 VERTEX 时请求直接打到 Google（400 API key not valid），
    // 网关日志里没有这条请求；补上这个变量后立刻命中网关。真实 project 账号的
    // authType 是 vertex-ai，不会读它，所以只在这一支补。
    if (baseUrl && value('VERTEX_AI_PLACEHOLDER') === 'true') {
      env.GOOGLE_GEMINI_BASE_URL = baseUrl;
    }
    // express 模式（只给 API Key、不给项目）不能带项目/地域，否则 SDK 改走 ADC 认证。
    if (value('VERTEX_AI_PROJECT_ID') && value('VERTEX_AI_PLACEHOLDER') !== 'true') {
      env.GOOGLE_CLOUD_PROJECT = value('VERTEX_AI_PROJECT_ID');
      if (value('VERTEX_AI_LOCATION')) env.GOOGLE_CLOUD_LOCATION = value('VERTEX_AI_LOCATION');
    }
  } else if (baseUrl) {
    env.GOOGLE_GEMINI_BASE_URL = baseUrl;
  }
  return env;
}

module.exports = { geminiCliEndpointEnv };
