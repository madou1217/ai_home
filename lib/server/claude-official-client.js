'use strict';

/**
 * Claude 订阅 OAuth 的官方客户端调用合同。
 *
 * 背景：Anthropic 依据客户端身份判定订阅额度是否可用。原生 Claude Code 自己在
 * 请求里带着这份身份，因此字节透传它的请求一直可用；而任何由网关重建的请求
 * （跨协议转码，或非官方客户端直接打 /v1/messages）都缺这份身份，会被上游按
 * 限流拒绝——同一账号、同一时刻、同一模型下 aih claude <id> 成功而网关 429。
 *
 * 本模块只做一件事：在缺失时补齐这份身份。已经带着它的请求（真实 Claude Code）
 * 一律不碰，保住既有的透明转发语义。
 */

const {
  isApiCredentialAccount
} = require('../account/runtime-auth-mode');

/**
 * 官方 CLI 每次请求的首个 system 块。
 * 取自官方源码 cli/src/constants/prompts.ts:452。官方随后追加的 CWD/Date 属于
 * 本地环境事实，网关侧没有等价语义，不自造。
 */
const CLAUDE_CODE_SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * 官方客户端身份 Header。
 * 取自本机回环抓包（假 Key 打 127.0.0.1，未连接 Anthropic）：正式 Claude Code
 * 2.1.224 对 POST /v1/messages 实发。不含 x-stainless-*——那是 SDK 运行环境
 * 遥测，不参与身份判定。
 */
const CLAUDE_CODE_IDENTITY_HEADERS = Object.freeze({
  'user-agent': 'claude-cli/2.1.224 (external, sdk-cli)',
  'x-app': 'cli',
  'anthropic-dangerous-direct-browser-access': 'true'
});

/**
 * 判断账号是否走官方端点上的订阅 OAuth。
 *
 * api-key 和 auth-token（第三方中转）走的是通用 API 合同，冒充官方 CLI 既无
 * 依据也可能被中转方按未知客户端拒绝；带自定义 baseUrl 的账号同理不是官方端点。
 */
function isNativeClaudeOAuthAccount(account) {
  if (!account) return false;
  if (String(account.provider || '').trim().toLowerCase() !== 'claude') return false;
  if (isApiCredentialAccount(account)) return false;
  return !String(account.baseUrl || '').trim();
}

/** 读取 system 字段的首个文本，兼容字符串与内容块数组两种合法形态。 */
function readFirstSystemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system) || system.length === 0) return '';
  const first = system[0];
  if (!first || typeof first !== 'object') return '';
  return String(first.text || '');
}

/** 判断请求体是否已经带着官方身份块（真实 Claude Code 的请求）。 */
function hasClaudeCodeIdentity(body) {
  if (!body || typeof body !== 'object') return false;
  return readFirstSystemText(body.system).startsWith(CLAUDE_CODE_SYSTEM_IDENTITY);
}

/**
 * 在缺失时把官方身份块补到 system 最前面。
 *
 * 客户端自己的 system 一律原样保留在其后，不被覆盖也不被改写。返回新对象，
 * 不修改入参。
 */
function ensureClaudeCodeSystem(body) {
  if (!body || typeof body !== 'object') return body;
  if (hasClaudeCodeIdentity(body)) return body;
  const identity = { type: 'text', text: CLAUDE_CODE_SYSTEM_IDENTITY };
  const existing = body.system;
  let system;
  if (typeof existing === 'string' && existing.trim()) {
    system = [identity, { type: 'text', text: existing }];
  } else if (Array.isArray(existing) && existing.length > 0) {
    system = [identity, ...existing];
  } else {
    system = [identity];
  }
  return { ...body, system };
}

/**
 * 补齐官方客户端身份 Header。
 * 客户端自己已经声明的同名 Header 优先保留：真实 Claude Code 转发过来时，
 * 它自报的版本比我们抓包的快照更准确。
 */
function applyClaudeCodeIdentityHeaders(headers, account) {
  if (!headers || !isNativeClaudeOAuthAccount(account)) return headers;
  for (const [name, value] of Object.entries(CLAUDE_CODE_IDENTITY_HEADERS)) {
    if (!String(headers[name] || '').trim()) headers[name] = value;
  }
  return headers;
}

/**
 * 对原始请求体缓冲区补齐官方身份块。
 *
 * 只在「原生订阅 OAuth」且「缺失身份」时才解析并重新序列化；其余情况原样返回
 * 同一个 Buffer，真实 Claude Code 的请求因此保持逐字节透传。正文不是合法 JSON
 * 时同样原样返回，不臆测其结构。
 */
function ensureClaudeCodeSystemBuffer(bodyBuffer, account) {
  if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return bodyBuffer;
  if (!isNativeClaudeOAuthAccount(account)) return bodyBuffer;
  let parsed;
  try {
    parsed = JSON.parse(bodyBuffer.toString('utf8'));
  } catch (_error) {
    return bodyBuffer;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bodyBuffer;
  if (hasClaudeCodeIdentity(parsed)) return bodyBuffer;
  return Buffer.from(JSON.stringify(ensureClaudeCodeSystem(parsed)), 'utf8');
}

module.exports = {
  CLAUDE_CODE_IDENTITY_HEADERS,
  ensureClaudeCodeSystemBuffer,
  CLAUDE_CODE_SYSTEM_IDENTITY,
  applyClaudeCodeIdentityHeaders,
  ensureClaudeCodeSystem,
  hasClaudeCodeIdentity,
  isNativeClaudeOAuthAccount
};
