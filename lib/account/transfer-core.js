'use strict';

// 账号凭据的身份推导小工具（provider 归一、API Key 身份、OAuth 邮箱、Codex auth 归一）。
// 账号迁移格式见 native-account-transfer.js；旧的 sub2api / Antigravity / CLIProxyAPI
// 转换已随导入导出重做一起删除（2026-10-31）。
const { getProviderCredentialStrategy } = require('./provider-credentials');
const { firstNonEmptyString, genericEmailCandidates } = require('./provider-credentials/transfer-fields');
const { decodeJwtPayloadUnsafe, extractCodexMetadata, normalizeCodexRefreshToken } = require('./codex-auth-metadata');

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function extractEmailFromJwt(token) {
  const payload = decodeJwtPayloadUnsafe(token);
  if (!payload || typeof payload !== 'object') return '';
  const profile = payload['https://api.openai.com/profile'];
  return firstNonEmptyString(
    payload.email,
    payload.emailAddress,
    profile && profile.email,
    payload.account && payload.account.email,
    payload.user && payload.user.email
  );
}

const EMAIL_HELPERS = Object.freeze({ extractCodexMetadata, extractEmailFromJwt });
// extractOAuthEmail 为函数声明，提升后可在此引用。
function extractOAuthEmail(provider, auth) {
  const p = normalizeProvider(provider);
  const payload = auth && typeof auth === 'object' ? auth : {};
  const nestedAuth = payload.auth && typeof payload.auth === 'object' ? payload.auth : {};
  const config = payload.config && typeof payload.config === 'object' ? payload.config : {};
  const credentials = payload.credentials && typeof payload.credentials === 'object' ? payload.credentials : {};
  const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
  const source = Object.keys(nestedAuth).length > 0 ? nestedAuth : payload;
  const tokens = source.tokens && typeof source.tokens === 'object' ? source.tokens : {};
  const fields = { payload, nestedAuth, config, credentials, meta, source, tokens };
  // 各 provider 的邮箱位置由凭据端口模块给出（按优先级）；没声明的只看通用位置。
  const strategy = getProviderCredentialStrategy(p);
  const candidates = typeof strategy.transferEmailCandidates === 'function'
    ? strategy.transferEmailCandidates(fields, EMAIL_HELPERS)
    : genericEmailCandidates(fields);
  return normalizeEmail(firstNonEmptyString(...candidates));
}

/** The transfer boundary uses the same policies as native registration, not an email shortcut. */
function extractProviderApiKey(p, payload, config, credentials, authCredentials, auth) {
  // provider 专属的凭据变量（凭据端口模块的 importCredentialEnv）优先，按来源再按变量名的顺序取第一个非空值。
  const special = getProviderCredentialStrategy(p).importCredentialEnv;
  if (special) {
    const value = firstNonEmptyString(...[payload, config, credentials, authCredentials, auth]
      .flatMap((source) => special.keys.map((key) => source[key])));
    if (value) return { apiKey: value, credentialType: special.credentialType };
  }

  return {
    apiKey: firstNonEmptyString(
      payload['api-key'],
      payload.apiKey,
      payload.api_key,
      payload.OPENAI_API_KEY,
      payload.ANTHROPIC_API_KEY,
      payload.GEMINI_API_KEY,
      payload.GOOGLE_API_KEY,
      config.apiKey,
      config.api_key,
      config.OPENAI_API_KEY,
      config.ANTHROPIC_API_KEY,
      config.GEMINI_API_KEY,
      config.GOOGLE_API_KEY,
      credentials['api-key'],
      credentials.apiKey,
      credentials.api_key,
      credentials.OPENAI_API_KEY,
      credentials.ANTHROPIC_API_KEY,
      credentials.GEMINI_API_KEY,
      credentials.GOOGLE_API_KEY,
      authCredentials['api-key'],
      authCredentials.apiKey,
      authCredentials.api_key,
      authCredentials.OPENAI_API_KEY,
      authCredentials.ANTHROPIC_API_KEY,
      authCredentials.GEMINI_API_KEY,
      authCredentials.GOOGLE_API_KEY,
      auth.OPENAI_API_KEY,
      auth.ANTHROPIC_API_KEY,
      auth.GEMINI_API_KEY,
      auth.GOOGLE_API_KEY
    ),
    credentialType: 'api-key'
  };
}

function extractApiKeyConfig(provider, record) {
  const p = normalizeProvider(provider);
  const payload = record && typeof record === 'object' ? record : {};
  const config = payload.config && typeof payload.config === 'object' ? payload.config : {};
  const auth = payload.auth && typeof payload.auth === 'object' ? payload.auth : {};
  const credentials = payload.credentials && typeof payload.credentials === 'object' ? payload.credentials : {};
  const authCredentials = auth.credentials && typeof auth.credentials === 'object' ? auth.credentials : {};
  const rawTokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : null;
  const hasOauthTokens = Boolean(rawTokens && (rawTokens.refresh_token || rawTokens.access_token || rawTokens.id_token));
  if (hasOauthTokens) return { apiKey: '', baseUrl: '' };

  const credential = extractProviderApiKey(p, payload, config, credentials, authCredentials, auth);
  const genericBaseUrl = firstNonEmptyString(
    payload['base-url'],
    payload.baseUrl,
    payload.base_url,
    payload.OPENAI_BASE_URL,
    payload.ANTHROPIC_BASE_URL,
    payload.GEMINI_BASE_URL,
    payload.XAI_BASE_URL,
    payload.KIMI_BASE_URL,
    config['base-url'],
    config.baseUrl,
    config.base_url,
    config.OPENAI_BASE_URL,
    config.ANTHROPIC_BASE_URL,
    config.GEMINI_BASE_URL,
    config.XAI_BASE_URL,
    config.KIMI_BASE_URL,
    credentials['base-url'],
    credentials.baseUrl,
    credentials.base_url,
    credentials.OPENAI_BASE_URL,
    credentials.ANTHROPIC_BASE_URL,
    credentials.GEMINI_BASE_URL,
    credentials.XAI_BASE_URL,
    credentials.KIMI_BASE_URL,
    authCredentials['base-url'],
    authCredentials.baseUrl,
    authCredentials.base_url,
    authCredentials.OPENAI_BASE_URL,
    authCredentials.ANTHROPIC_BASE_URL,
    authCredentials.GEMINI_BASE_URL,
    authCredentials.XAI_BASE_URL,
    authCredentials.KIMI_BASE_URL,
    auth.OPENAI_BASE_URL,
    auth.ANTHROPIC_BASE_URL,
    auth.GEMINI_BASE_URL,
    auth.XAI_BASE_URL,
    auth.KIMI_BASE_URL
  );
  // provider 专属的基础地址变量（凭据端口模块 importCredentialEnv.baseUrlKeys）只在通用位置都没有时兜底，
  // 不改变其它 provider 的 API 密钥身份。
  const baseUrlKeys = (getProviderCredentialStrategy(p).importCredentialEnv || {}).baseUrlKeys || [];
  const baseUrl = genericBaseUrl || firstNonEmptyString(...[payload, config, credentials, authCredentials, auth]
    .flatMap((source) => baseUrlKeys.map((key) => source[key])));
  return {
    apiKey: String(credential.apiKey || '').trim(),
    baseUrl: normalizeBaseUrl(baseUrl),
    provider: p,
    credentialType: credential.credentialType
  };
}

function buildApiKeyIdentity(provider, config) {
  const p = normalizeProvider(provider);
  const extracted = extractApiKeyConfig(p, config);
  if (!p || !extracted.apiKey) return '';
  const prefix = extracted.credentialType === 'auth-token' ? 'auth_token' : 'api_key';
  return `${prefix}:${p}:${normalizeBaseUrl(extracted.baseUrl)}:${encodeURIComponent(extracted.apiKey)}`;
}

function normalizeCodexAuthPayload(input) {
  const payload = input && typeof input === 'object' ? input : null;
  if (!payload) return null;

  const existingTokens = payload.tokens && typeof payload.tokens === 'object' ? payload.tokens : null;
  const credentials = payload.credentials && typeof payload.credentials === 'object' ? payload.credentials : {};
  const accessToken = String(payload.access_token || payload.accessToken || credentials.access_token || credentials.accessToken || (existingTokens && existingTokens.access_token) || '').trim();
  const refreshToken = normalizeCodexRefreshToken(payload.refresh_token || payload.refreshToken || credentials.refresh_token || credentials.refreshToken || (existingTokens && existingTokens.refresh_token));
  const idToken = String(payload.id_token || payload.idToken || credentials.id_token || credentials.idToken || (existingTokens && existingTokens.id_token) || '').trim();
  const upstreamAccountId = String(
    payload.chatgpt_account_id
    || payload.account_id
    || credentials.chatgpt_account_id
    || credentials.account_id
    || (existingTokens && existingTokens.account_id)
    || ''
  ).trim();
  if (!refreshToken) return null;

  const authJson = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      account_id: upstreamAccountId
    },
    last_refresh: String(payload.last_refresh || payload.lastRefresh || '').trim() || new Date().toISOString()
  };
  const email = extractOAuthEmail('codex', payload);
  if (email) authJson.email = email;
  return authJson;
}

module.exports = {
  normalizeProvider,
  normalizeBaseUrl,
  extractOAuthEmail,
  extractApiKeyConfig,
  buildApiKeyIdentity,
  normalizeCodexAuthPayload
};
