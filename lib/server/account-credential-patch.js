'use strict';

// **账号凭据补丁注册表**（Table-Driven Mapping + Strategy）。
//
// 「WebUI 改账号」要做的凭据写入对每个 provider 都不一样（env 键名、Claude 的认证方式切换），
// 但这些差异全是**数据映射**。因此按 provider 注册成补丁策略，路由层只调两个具名入口：
//   resolveCredentialBaseUrl(provider, env)   —— 读当前生效的上游地址（用于自环账号判定）
//   applyCredentialPatch(provider, ctx)       —— 把 payload 合并进 env（返回错误或新的认证方式）
// 路由层不再出现 `if (provider === '…')`。

const { getClaudeCredentialType, writeClaudeCredentialEnv } = require('../account/claude-credential');

function text(value) {
  return String(value == null ? '' : value).trim();
}

// 通用 env 合并：apiKey 写进声明的键，baseUrl 有则写、空则删。
function applyGenericEnvPatch(env, { apiKeyEnvKeys, baseUrlEnvKey, apiKey, baseUrl, payload }) {
  if (apiKey && apiKeyEnvKeys.length > 0) {
    apiKeyEnvKeys.forEach((key) => { env[key] = apiKey; });
  }
  if (payload && 'baseUrl' in payload && baseUrlEnvKey) {
    if (baseUrl) env[baseUrlEnvKey] = baseUrl;
    else delete env[baseUrlEnvKey];
  }
}

const CREDENTIAL_PATCHES = Object.freeze({
  codex: {
    baseUrlEnvKey: 'OPENAI_BASE_URL',
    apiKeyEnvKeys: ['OPENAI_API_KEY'],
    apply: (env, ctx) => applyGenericEnvPatch(env, {
      apiKeyEnvKeys: ['OPENAI_API_KEY'],
      baseUrlEnvKey: 'OPENAI_BASE_URL',
      ...ctx
    })
  },
  gemini: {
    baseUrlEnvKey: 'GEMINI_BASE_URL',
    apiKeyEnvKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    apply: (env, ctx) => applyGenericEnvPatch(env, {
      apiKeyEnvKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
      baseUrlEnvKey: 'GEMINI_BASE_URL',
      ...ctx
    })
  },
  agy: {
    baseUrlEnvKey: 'AGY_BASE_URL',
    apiKeyEnvKeys: ['AGY_ACCESS_TOKEN'],
    apply: (env, ctx) => applyGenericEnvPatch(env, {
      apiKeyEnvKeys: ['AGY_ACCESS_TOKEN'],
      baseUrlEnvKey: 'AGY_BASE_URL',
      ...ctx
    })
  },
  // Claude 的凭据是「认证方式 + token」的组合信封，切换方式必须同时给新密钥。
  claude: {
    baseUrlEnvKey: 'ANTHROPIC_BASE_URL',
    apiKeyEnvKeys: [],
    apply(env, { apiKey, baseUrl, payload, credentialType }) {
      const requested = getClaudeCredentialType({ credentialType });
      const current = getClaudeCredentialType({ env }) || 'api-key';
      const next = requested || current;
      if (requested && requested !== current && !apiKey) {
        return {
          ok: false,
          error: 'credential_required_for_auth_type_switch',
          message: '切换 Claude 认证方式时需要重新输入密钥。'
        };
      }
      const credentialPatch = { credentialType: next, token: apiKey };
      if (payload && 'baseUrl' in payload) credentialPatch.baseUrl = baseUrl;
      const nextEnvJson = writeClaudeCredentialEnv(env, credentialPatch);
      Object.keys(env).forEach((key) => { delete env[key]; });
      Object.assign(env, nextEnvJson);
      return { ok: true, credentialType: getClaudeCredentialType({ env }) || next };
    }
  }
});

function getCredentialPatch(providerRaw) {
  const provider = text(providerRaw).toLowerCase();
  return CREDENTIAL_PATCHES[provider] || null;
}

// 读当前生效的上游地址：payload 里带了就用它，否则按 provider 声明的 env 键读。
function resolveCredentialBaseUrl(providerRaw, credentialEnv, { baseUrl, payload } = {}) {
  if (payload && 'baseUrl' in payload) return baseUrl;
  const patch = getCredentialPatch(providerRaw);
  if (!patch || !patch.baseUrlEnvKey) return '';
  return text((credentialEnv || {})[patch.baseUrlEnvKey]);
}

// 把 payload 合并进 env（原地修改）。返回 { ok, credentialType? } 或错误对象。
function applyCredentialPatch(providerRaw, { env, apiKey, baseUrl, payload, credentialType }) {
  const patch = getCredentialPatch(providerRaw);
  if (!patch) return { ok: true, credentialType: '' };
  const result = patch.apply(env, { apiKey, baseUrl, payload, credentialType }) || { ok: true };
  return { credentialType: '', ...result };
}

module.exports = {
  applyCredentialPatch,
  getCredentialPatch,
  resolveCredentialBaseUrl
};
