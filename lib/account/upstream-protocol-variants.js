'use strict';

// 「同一个账号也能用另一种协议访问」的**能力表**（provider + protocol → 端点/凭据形状）。
//
// 为什么需要它：账号的 provider 描述的是**凭据/登录边界**，不是上游只会说一种协议。
// DeepSeek / Kimi / 智谱 / 百炼都同时提供 Anthropic 与 OpenAI 两套端点，用户把
// Anthropic 地址加进 claude 只是因为他要在 Claude Code 里用；这不代表 codex 调它时
// 也得走 Anthropic 适配层（实测 DeepSeek 那层会把工具调用吐成 DSML 文本）。
//
// 派发处只问这张表要能力，不写 `if (provider === 'claude')`：
//   - 网关：OpenAI 客户端 + 表格命中 → 直接按 OpenAI Chat Completions 发上游；
//   - CLI：`--model-alias claude.<model>` 命中 → 询问用户「自动适配 / 复制到 codex」。
//
// 新增一家双协议厂商 = 往 `dual-format-endpoints.js` 加一行；新增一种可迁移的凭据形状 =
// 往这里加一个 variant。

const { resolveOpenAICompatibleBaseUrl } = require('./dual-format-endpoints');
const { readClaudeCredential } = require('./claude-credential');

const UPSTREAM_PROTOCOL_VARIANTS = Object.freeze([
  Object.freeze({
    provider: 'claude',
    protocol: 'openai_chat',
    // 目标端点的 OpenAI 基址已经包含版本段（/v1、/api/paas/v4…），所以路径固定为
    // /chat/completions，不再走 claude 的 /v1 前缀剥离规则。
    upstreamPath: '/chat/completions',
    resolveBaseUrl(account) {
      return resolveOpenAICompatibleBaseUrl(account && (account.baseUrl || account.openaiBaseUrl));
    },
    // CLI 侧从凭据记录里读「可复制的源」：只要 API Key / Auth Token，不要 OAuth。
    // OAuth 令牌换到另一家端点没有意义，也不该被复制。
    readCopySource(env) {
      const credential = readClaudeCredential({ env: env || {} });
      if (!credential.token) return null;
      const baseUrl = String(env && env.ANTHROPIC_BASE_URL || '').trim();
      const openAIBaseUrl = resolveOpenAICompatibleBaseUrl(baseUrl);
      if (!openAIBaseUrl) return null;
      return {
        token: credential.token,
        credentialType: credential.credentialType,
        baseUrl,
        openAIBaseUrl
      };
    },
    copyTarget: Object.freeze({
      provider: 'codex',
      buildEnv(source) {
        return {
          OPENAI_API_KEY: String(source && source.token || '').trim(),
          OPENAI_BASE_URL: String(source && source.openAIBaseUrl || '').trim()
        };
      }
    })
  })
]);

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeProtocol(value) {
  return String(value || '').trim().toLowerCase();
}

function getUpstreamProtocolVariant(provider, protocol) {
  const targetProvider = normalizeProvider(provider);
  const targetProtocol = normalizeProtocol(protocol);
  if (!targetProvider || !targetProtocol) return null;
  return UPSTREAM_PROTOCOL_VARIANTS.find((variant) => (
    variant.provider === targetProvider && variant.protocol === targetProtocol
  )) || null;
}

function supportsUpstreamProtocol(provider, protocol) {
  return Boolean(getUpstreamProtocolVariant(provider, protocol));
}

/**
 * 账号 → 「按指定协议访问时应使用的上游」。
 * 表格没有这个 provider/protocol，或账号的地址不是已知双协议端点时返回 null。
 */
function resolveUpstreamProtocolTarget(provider, protocol, account) {
  const variant = getUpstreamProtocolVariant(provider, protocol);
  if (!variant) return null;
  const baseUrl = String(
    typeof variant.resolveBaseUrl === 'function'
      ? variant.resolveBaseUrl(account || {})
      : ''
  ).trim();
  if (!baseUrl) return null;
  return {
    provider: variant.provider,
    protocol: variant.protocol,
    baseUrl,
    path: variant.upstreamPath || '/chat/completions'
  };
}

/**
 * 只保留「能用指定协议访问」的账号。
 *
 * `protocol` 为空（没有会话级选择）时原样返回，不改变任何既有路由。
 * 表格里没有这个 provider/protocol 时也原样返回：这不是一条可用约束，忽略比误杀安全。
 */
function filterAccountsForUpstreamProtocol(accounts, provider, protocol) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (!normalizeProtocol(protocol)) return list;
  if (!supportsUpstreamProtocol(provider, protocol)) return list;
  return list.filter((account) => Boolean(resolveUpstreamProtocolTarget(provider, protocol, account)));
}

function listUpstreamProtocolVariants() {
  return UPSTREAM_PROTOCOL_VARIANTS.map((variant) => ({
    provider: variant.provider,
    protocol: variant.protocol,
    upstreamPath: variant.upstreamPath,
    hasCopyTarget: Boolean(variant.copyTarget)
  }));
}

module.exports = {
  UPSTREAM_PROTOCOL_VARIANTS,
  filterAccountsForUpstreamProtocol,
  getUpstreamProtocolVariant,
  listUpstreamProtocolVariants,
  resolveUpstreamProtocolTarget,
  supportsUpstreamProtocol
};
