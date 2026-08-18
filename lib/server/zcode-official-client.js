'use strict';

/**
 * ZCode 桌面端（OAuth 计划账号）的官方客户端调用合同。
 *
 * 背景：与 Claude 订阅 OAuth 同理（见 claude-official-client.js），zcode-plan
 * 推理端点按客户端身份做风控评分。2026-08-18 经 mitm 对原生桌面端取证
 * （.tmp-mitm 探针直驱 zcode.cjs + 真实桌面窗口抓包），成功请求（200 SSE）
 * 恒定携带本模块这份身份头与 metadata.user_id；缺验证码头时一律 400/3007，
 * 验证码通过但身份/窗口不满足时 405/3012（"method not allowed"，间歇性闸）。
 *
 * 关键实证：成功的黄金请求里 user-agent 是 ZCode 桌面端自己的 UA，而不是求解
 * 验证码的浏览器 UA——verify param 不绑定求解环境的 UA，因此 captcha 重试时
 * 绝不能用浏览器 UA 覆盖本身份（曾经这么干，反而离黄金请求更远）。
 *
 * 本模块只在缺失/非官方形态时补齐；API-key 账号与自定义 baseUrl 账号不适用。
 */

const crypto = require('node:crypto');

const {
  isApiCredentialAccount
} = require('../account/runtime-auth-mode');

/**
 * 官方桌面端身份 Header，逐字节取自 2026-08-18 mitm 黄金请求
 * （ZCode 3.7.7 Windows 桌面端对 /api/v1/zcode-plan/anthropic/v1/messages 实发，
 * 200 SSE 成功响应）。x-os-* 是客户端自报遥测，不参与设备指纹判定。
 */
const ZCODE_DESKTOP_IDENTITY_HEADERS = Object.freeze({
  'user-agent': 'ZCode/3.7.7 ai-sdk/provider-utils/4.0.27 runtime/node.js/24',
  'http-referer': 'https://zcode.z.ai',
  'x-zcode-agent': 'glm',
  'x-zcode-app-version': '3.7.7',
  'x-title': 'Z Code@electron',
  'x-platform': 'win32-x64',
  'x-os-category': 'windows',
  'x-os-version': '10.0.26200',
  'anthropic-beta': 'mid-conversation-system-2026-04-07'
});

/** 判断账号是否走 zcode 官方端点上的 OAuth 计划（与上游双头分支同口径）。 */
function isNativeZcodeOAuthAccount(account) {
  if (!account) return false;
  if (String(account.provider || '').trim().toLowerCase() !== 'zcode') return false;
  if (isApiCredentialAccount(account)) return false;
  return !String(account.baseUrl || '').trim();
}

/**
 * 账号级稳定 device_id：由 accountRef 确定性派生的 UUID（不是机器指纹，
 * 同一账号恒定、跨账号互异，符合 Account Runtime Identity 语义）。
 */
function zcodeDeviceIdForAccount(account) {
  const digest = crypto
    .createHash('sha256')
    .update(`zcode-desktop-device:${String(account && account.accountRef || '')}`)
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * 对齐黄金请求身份。与 Claude 版不同：下游客户端永远不是真实 ZCode 桌面端，
 * 因此身份头一律覆盖（包括 user-agent），并生成每请求随机的 query/request/
 * trace id 与会话 id。返回 { headers, bodyBuffer }；bodyBuffer 仅在需要注入
 * metadata.user_id 时重新序列化，其余情况原样返回同一个 Buffer。
 */
function applyZcodeDesktopIdentity(headers, bodyBuffer, account) {
  if (!headers || !isNativeZcodeOAuthAccount(account)) {
    return { headers, bodyBuffer };
  }
  const sessionId = crypto.randomUUID();
  for (const [name, value] of Object.entries(ZCODE_DESKTOP_IDENTITY_HEADERS)) {
    headers[name] = value;
  }
  headers['x-query-id'] = crypto.randomUUID();
  headers['x-request-id'] = crypto.randomUUID();
  headers['x-session-id'] = sessionId;
  headers['x-zcode-trace-id'] = crypto.randomUUID();

  let nextBody = bodyBuffer;
  if (Buffer.isBuffer(bodyBuffer) && bodyBuffer.length > 0) {
    let parsed;
    try {
      parsed = JSON.parse(bodyBuffer.toString('utf8'));
    } catch (_error) {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const metadata = parsed.metadata && typeof parsed.metadata === 'object'
        ? parsed.metadata
        : {};
      if (!String(metadata.user_id || '').trim()) {
        metadata.user_id = JSON.stringify({
          device_id: zcodeDeviceIdForAccount(account),
          account_uuid: '',
          session_id: sessionId
        });
        nextBody = Buffer.from(JSON.stringify({ ...parsed, metadata }), 'utf8');
      }
    }
  }
  return { headers, bodyBuffer: nextBody };
}

module.exports = {
  ZCODE_DESKTOP_IDENTITY_HEADERS,
  applyZcodeDesktopIdentity,
  isNativeZcodeOAuthAccount,
  zcodeDeviceIdForAccount
};
