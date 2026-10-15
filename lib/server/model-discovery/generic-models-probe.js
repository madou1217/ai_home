// 通用 OpenAI/Anthropic 兼容 /models 探测 —— 从 http-utils.fetchModelsForAccount 抽出为独立实现，
// 供 provider 描述符声明的 `generic-models-probe` handler 使用（api-key 模式与第三方端点账号）。
// 逻辑与原实现逐字节一致；调用方只提供 requestOptions/provider/account/timeoutMs/fetchWithTimeout。

const { isClaudeAuthTokenAccount } = require('../../account/claude-credential');
const { resolveProviderBaseUrl } = require('../http-utils-code-assist');
const { isApiCredentialAccount } = require('../../account/runtime-auth-mode');
const { buildKimiRequestHeaders } = require('../kimi-request-headers');
const { registerProbedModelLimits } = require('../probed-model-limits');
const { attachKimiProbedModelDescriptors } = require('../http-utils-kimi');
const { isZcodeRoutableModelId } = require('../http-utils-zcode');
const { readResponseJson, readResponseText, sanitizeResponseText } = require('../response-body');

// **通用 /models 探测的 provider 档案**（数据）：认证头形态、模型列表路径风格、附加请求头、
// 数据后处理与 ID 过滤。探测代码只按 provider 取档案，不写 provider 名比较。
//   apiKeyHeader    —— API Key 账号要用的认证头名（缺省 Authorization: Bearer）
//   authTokenProxy  —— 该 provider 存在「第三方 auth-token 代理账号」形态（claude）
//   pathStyle       —— 模型列表路径风格：'bare' = <base>/models，'versioned' = <base>/v1/models
//   extraHeaders    —— 附加请求头（按账号形态给）
//   onData          —— 拿到 data 数组后的后处理（如登记 kimi 的探针描述符）
//   filterId        —— 过滤不可路由的模型 ID
const PROBE_PROFILES = Object.freeze({
  claude: Object.freeze({
    apiKeyHeader: 'x-api-key',
    authTokenProxy: true,
    // 第三方 auth-token 代理（base 不带版本段）的模型在 <base>/v1/models；其余情况 base 已带 /v1。
    pathStyle: ({ authTokenProxy, baseUrlHasVersion }) => (
      authTokenProxy && !baseUrlHasVersion ? 'versioned' : 'bare'
    ),
    extraHeaders: ({ isApiKey, authTokenProxy }) => ({
      // Anthropic 的 API 缺 anthropic-version 会被拒；OAuth 还需要 oauth beta 头。
      // oauth-beta 只给真 OAuth：auth-token（第三方代理）不是 OAuth，发了可能被代理拒。
      'anthropic-version': '2023-06-01',
      ...(!isApiKey && !authTokenProxy ? { 'anthropic-beta': 'oauth-2025-04-20' } : {})
    })
  }),
  gemini: Object.freeze({ pathStyle: () => 'bare' }),
  agy: Object.freeze({ pathStyle: () => 'bare' }),
  kimi: Object.freeze({
    extraHeaders: ({ account, isApiKey }) => (isApiKey ? {} : buildKimiRequestHeaders(account)),
    onData: (account, data) => attachKimiProbedModelDescriptors(account, data)
  }),
  zcode: Object.freeze({
    // zcode API-key 账号直探 bigmodel anthropic /v1/models，返回的 coding 目录含
    // opencode-go/*、cline-free/* 伙伴命名空间（推理端点不认，且网关会把它们路由到
    // opencode 造成误计费）——与 OAuth 探测同规则，只留可路由回 zcode 的 ID。
    filterId: (id) => isZcodeRoutableModelId(id)
  })
});

const EMPTY_PROBE_PROFILE = Object.freeze({});

function getProbeProfile(provider) {
  return PROBE_PROFILES[String(provider || '').trim().toLowerCase()] || EMPTY_PROBE_PROFILE;
}

async function fetchGenericModelsProbe({ requestOptions, provider, account, timeoutMs, fetchWithTimeout }) {
  const profile = getProbeProfile(provider);
  const claudeAuthTokenProxy = profile.authTokenProxy === true && isClaudeAuthTokenAccount(account);
    const baseUrl = resolveProviderBaseUrl(requestOptions, account);
    const baseUrlHasVersion = /\/v[0-9][^/]*$/i.test(baseUrl);
    // 不同第三方代理的模型列表路径不一致:GLM(base=.../anthropic 不带 /vN)在 <base>/v1/models,
    // DeepSeek(base=https://api.deepseek.com)在 <base>/models。单一硬编码 path 会让其中一家 404
    // →「无可用模型」。策略:先按下方主 path 探,失败(404 等)再回退另一个 path。
    const primaryPath = (typeof profile.pathStyle === 'function'
      ? profile.pathStyle({ authTokenProxy: claudeAuthTokenProxy, baseUrlHasVersion }) === 'bare'
      : baseUrlHasVersion)
      ? '/models'
      : '/v1/models';
    const altPath = primaryPath === '/models' ? '/v1/models' : '/models';
    // Anthropic authenticates API keys via x-api-key and OAuth tokens via
    // Authorization: Bearer — never the reverse. The probe must mirror the real
    // request path (upstream-endpoints.js / webui-chat-routes.js both send
    // x-api-key for claude API-key accounts), otherwise a working account fails
    // the probe with a spurious 401 authentication_error.
    const isApiKeyAccount = isApiCredentialAccount(account);
    const headers = {};
    // Anthropic authenticates API keys via x-api-key and OAuth tokens via
    // Authorization: Bearer — never the reverse. The probe must mirror the real
    // request path (upstream-endpoints.js / webui-chat-routes.js both send
    // x-api-key for claude API-key accounts), otherwise a working account fails
    // the probe with a spurious 401 authentication_error.
    if (isApiKeyAccount && profile.apiKeyHeader) {
      headers[profile.apiKeyHeader] = account.accessToken;
    } else {
      headers.authorization = `${String(account && account.tokenType || 'Bearer').trim() || 'Bearer'} ${account.accessToken}`;
    }
    if (typeof profile.extraHeaders === 'function') {
      Object.assign(headers, profile.extraHeaders({
        account,
        isApiKey: isApiKeyAccount,
        authTokenProxy: claudeAuthTokenProxy
      }));
    }
    const tryFetchModels = async (url) => {
      const res = await fetchWithTimeout(url, { method: 'GET', headers }, timeoutMs, {
        proxyUrl: requestOptions.proxyUrl,
        noProxy: requestOptions.noProxy
      });
      if (!res.ok) {
        const text = await readResponseText(res).catch(() => '');
        const err = new Error(`HTTP ${res.status} ${sanitizeResponseText(text, 160)}`.trim());
        err.status = res.status;
        throw err;
      }
      const json = await readResponseJson(res);
      // 有些第三方代理(如 bigmodel)对【错误路径】返回 HTTP 200 + 错误体
      // {code,msg:"404 NOT_FOUND",success:false}——res.ok 为真但没有 data 数组。必须视为失败
      // 以触发下方另一路径回退,否则会静默返回空列表 → 账号「无可用模型」。
      if (json && json.success === false) {
        throw new Error(String(`${json.code ? json.code + ' ' : ''}${json.msg || 'models_error'}`).trim());
      }
      if (!Array.isArray(json && json.data)) {
        throw new Error('models_response_missing_data');
      }
      if (typeof profile.onData === 'function') profile.onData(account, json.data);
      const ids = json.data
        .map((x) => String((x && x.id) || '').trim())
        .filter(Boolean)
        .filter((id) => (typeof profile.filterId === 'function' ? profile.filterId(id) : true));
      registerProbedModelLimits(account && account.accountRef, json.data, ids);
      return ids;
    };

    // 候选 URL,按序试、返回第一个拿到 data 数组的:
    //  1) base 相对(GLM:模型在 <base=.../anthropic>/v1/models);
    //  2) host 根(DeepSeek:base=.../anthropic 但模型在 host 根 api.deepseek.com/models,不在 /anthropic 下)。
    // 覆盖"路径不在 base 之下"和"200+错误体"两种坑,不再因单一路径 404/空而「无可用模型」。
    const rel = String(baseUrl || '').replace(/\/+$/, '');
    let origin = '';
    try { origin = new URL(baseUrl).origin; } catch (_error) { origin = ''; }
    const candidates = [];
    const addUrl = (u) => { if (u && !candidates.includes(u)) candidates.push(u); };
    addUrl(`${rel}${primaryPath}`);
    addUrl(`${rel}${altPath}`);
    if (origin && origin !== rel) {
      addUrl(`${origin}/v1/models`);
      addUrl(`${origin}/models`);
    }

    let firstError = null;
    for (const url of candidates) {
      try {
        return await tryFetchModels(url);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
    throw firstError || new Error('models_response_missing_data');
}

module.exports = { fetchGenericModelsProbe, getProbeProfile };
