'use strict';

// **在场判定探针注册表**（Table-Driven Mapping）。
//
// 账号页要回答的第一个问题永远是同一个：「这条 DB 记录算不算已配置？它是 API Key 账号吗？」
// 但每种凭据形态的判法不同（OAuth token / 原生凭据信封 / 本机登录态摘要），因此**按 provider
// 注册成探针**，视图层只调 `readFastAccountPresence()`，不再出现 `if (provider === '…')`。
//
// 探针条目契约（全部字段都是**数据**，派发处不判 provider）：
//   read(ctx)                     —— 只看原生凭据时的判定
//   selfDetermining: true         —— 该探针自己决定一切（连 DB env 里的 API Key 也由它看）
//   credentialPresence(ctx)       —— DB env 里有凭据时的判定（缺省 = 有凭据即已配置）
//   credentialPresenceApiKeyMode  —— 上面的缺省判定里 apiKeyMode 取值（默认 true；agy/opencode
//                                    的 env 凭据是 OAuth 投影，不是 API Key）
// ctx = { provider, dbCredentials, nativeAuth, authMetadata, options }

const { isCodebuddyFamilyProvider, summarizeCodebuddyAuth } = require('../account/codebuddy-account-status');
const { summarizeClineAuth } = require('../account/cline-account-status');
const { readClaudeOauthCredential } = require('../account/claude-credential');
const { hasUsableKimiOAuth } = require('../account/kimi-auth');
const { hasKimiApiKey } = require('../profile/credential-config');
const { readZcodeOAuthCredential } = require('../account/zcode-credential');

function text(value) {
  return String(value == null ? '' : value).trim();
}

const PROBES = Object.freeze({
  // kimi 的探针自己看 API Key（env 里的 kimi key 与 OAuth 登录态是两套）。
  kimi: {
    selfDetermining: true,
    read(ctx) {
      const apiKeyMode = hasKimiApiKey(ctx.dbCredentials);
      return {
        configured: apiKeyMode || hasUsableKimiOAuth(ctx.nativeAuth),
        apiKeyMode
      };
    }
  },
  codex: {
    read(ctx) {
      const tokens = ctx.nativeAuth.auth && ctx.nativeAuth.auth.tokens;
      return { configured: Boolean(text(tokens && tokens.access_token)), apiKeyMode: false };
    }
  },
  gemini: {
    read(ctx) {
      const oauth = ctx.nativeAuth.oauthCreds || {};
      const accounts = ctx.nativeAuth.googleAccounts || {};
      return {
        configured: Boolean(
          text(oauth.access_token || oauth.refresh_token)
          || text(accounts.active)
        ),
        apiKeyMode: false
      };
    }
  },
  claude: {
    read(ctx) {
      return {
        configured: readClaudeOauthCredential(ctx.nativeAuth, ctx.options).configured,
        apiKeyMode: false
      };
    }
  },
  agy: {
    credentialPresenceApiKeyMode: false,
    credentialPresence(ctx) {
      return {
        configured: Boolean(
          text(ctx.dbCredentials.AGY_ACCESS_TOKEN || ctx.dbCredentials.GOOGLE_OAUTH_ACCESS_TOKEN)
          || (ctx.authMetadata && ctx.authMetadata.configured)
        ),
        apiKeyMode: false
      };
    },
    read(ctx) {
      return { configured: Boolean(ctx.authMetadata && ctx.authMetadata.configured), apiKeyMode: false };
    }
  },
  opencode: {
    credentialPresenceApiKeyMode: false,
    read(ctx) {
      return {
        configured: Boolean(ctx.nativeAuth.auth && Object.keys(ctx.nativeAuth.auth).length > 0),
        apiKeyMode: false
      };
    }
  },
  // zcode OAuth 凭据是 AES-GCM 信封（nativeAuth.credentials），解不开（跨机器导入未带
  // secret）时按令牌键存在判定，与 status.js 的 zcode 分支一致。
  zcode: {
    read(ctx) {
      const credentials = ctx.nativeAuth.credentials && typeof ctx.nativeAuth.credentials === 'object'
        ? ctx.nativeAuth.credentials
        : {};
      return {
        configured: readZcodeOAuthCredential(ctx.nativeAuth).configured
          || Object.keys(credentials).some((key) => key.startsWith('oauth:') || key === 'zcodejwttoken'),
        apiKeyMode: false
      };
    }
  },
  // Cline 不进运行时账号池（与家族同理），登录态只能从 DB 里的原生凭据判断。
  cline: {
    read(ctx) {
      const summary = summarizeClineAuth(ctx.nativeAuth);
      return {
        configured: summary.configured,
        apiKeyMode: summary.apiKeyMode,
        authReason: summary.reason || '',
        ...(summary.accountName ? { displayName: summary.accountName } : {})
      };
    }
  }
});

// CodeBuddy / WorkBuddy 家族不进运行时账号池，只能从原生凭据判断登录态与账号名。
function readFamilyPresence(provider, nativeAuth, options) {
  const summary = summarizeCodebuddyAuth(provider, nativeAuth, options.nowMs);
  return {
    configured: summary.configured,
    apiKeyMode: false,
    authReason: summary.reason || '',
    ...(summary.accountName ? { displayName: summary.accountName } : {})
  };
}

function readFastAccountPresence(providerRaw, record, authMetadata = null, options = {}) {
  const provider = text(providerRaw).toLowerCase();
  const dbCredentials = record && record.env && typeof record.env === 'object' ? record.env : {};
  const nativeAuth = record ? record.nativeAuth : {};
  const ctx = { provider, dbCredentials, nativeAuth, authMetadata, options };
  const probe = PROBES[provider];

  // 1) 自己决定一切的探针（kimi：API Key 与 OAuth 两套都在它内部判）。
  if (probe && probe.selfDetermining) return probe.read(ctx);

  // 2) DB env 里有凭据：探针可给特例判法，缺省是「有凭据即已配置」。
  if (Object.keys(dbCredentials).length > 0) {
    if (probe && typeof probe.credentialPresence === 'function') return probe.credentialPresence(ctx);
    return {
      configured: true,
      apiKeyMode: !probe || probe.credentialPresenceApiKeyMode !== false
    };
  }

  // 3) 只看原生凭据：探针 → 家族摘要 → 默认未配置。
  if (probe) return probe.read(ctx);
  if (isCodebuddyFamilyProvider(provider)) return readFamilyPresence(provider, nativeAuth, options);
  return { configured: false, apiKeyMode: false };
}

// 「在场判定只来自 DB 已登记凭据」的 provider：CodeBuddy / WorkBuddy 家族与 Cline。
// 它们都不在运行时账号池里（没有 runtimeAccount 可发布），但页面仍须收到显式运行时状态
// ——包括 healthy，用来清掉浏览器里保留的上一次认证失败状态。
function isCredentialOnlyProvider(provider) {
  const normalized = text(provider).toLowerCase();
  return isCodebuddyFamilyProvider(normalized) || normalized === 'cline';
}

module.exports = {
  readFastAccountPresence,
  isCredentialOnlyProvider
};
