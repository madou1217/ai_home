'use strict';

// **relay 推理请求鉴权头的策略表**（策略模式：kind 是键，实现是值）。
//
// 为什么要有这个模块：`upstream-endpoints-transport-general.js` 是**所有 provider 共用**
// 的传输层，在里面写 `if (provider === 'zcode') { …头怎么拼… }` 会让每个 provider 的
// 鉴权细节都堆在同一个文件里——多会话并行时那个文件必然反复冲突（本仓库真实教训）。
// 因此「鉴权头怎么拼」由 provider 的**描述符声明**（`capabilities.relay.auth.kind`）
// 选策略，本模块按 kind 查表，**不认 provider 名**。
//
// 新增一种鉴权形态 = 加一个 kind（contract.js 的 RELAY_AUTH_KINDS）+ 这里加一条实现，
// 共享传输文件零改动。
//
// 表项签名：({ account, resolvedToken, auth }) => Record<string,string>
//   account       运行池里的账号对象（含区域 access_token / 长期 jwt 等原生字段）
//   resolvedToken 已按描述符解析好的推理凭据（business_token 换取 / jwt 直通）
//   auth          描述符的 relay.auth 声明（extraHeader / extraTokenField 等）

const { isJwtPlanAccount } = require('./relay-auth-plan-kind');

function text(value) {
  return String(value == null ? '' : value).trim();
}

const STRATEGIES = Object.freeze({
  // 单头：Authorization: Bearer <解析出的凭据>。
  business_token: ({ resolvedToken }) => ({
    authorization: `Bearer ${text(resolvedToken)}`
  }),

  // 双头（zcode ultra 端点）：两个头**来源不同**。
  //   authorization        = 区域 access_token（account.accessToken），**不是**解析出的 jwt
  //   <extraHeader>        = 长期 jwt（account[extraTokenField]，默认 zcodeJwtToken）
  // 真机矩阵（bigmodel 与 zai 两区一致）：
  //   access_token + jwt 头 -> 429/200（被正常处理）
  //   jwt          + jwt 头 -> 401 token expired or incorrect
  //   access_token（缺 jwt 头） -> 401 SERVICE_AUTHENTICATION_INVALID
  //
  // **长期 jwt 直通套餐是单头**（2026-10-27 真机纠偏）：start-plan 家族的推理端点
  // 是 zcode.z.ai 自己的 `zcode-plan` 端点，它只认 `Authorization: Bearer <jwt>`；
  // 打 ultra 端点并送 access_token 会得到 401（那些账号的 access_token 早已过期），
  // 而 401 会被判成 auth_invalid（1 年冷却）。判定复用描述符的 jwtPlanKinds
  // （与 upstream-credential-resolver 同源，见 relay-auth-plan-kind）。
  business_token_pair: ({ account, resolvedToken, auth }) => {
    if (isJwtPlanAccount(account, auth)) {
      return { authorization: `Bearer ${text(resolvedToken)}` };
    }
    const field = text(auth && auth.extraTokenField) || 'zcodeJwtToken';
    const headerName = text(auth && auth.extraHeader);
    const regionToken = text(account && account.accessToken) || text(resolvedToken);
    const headers = { authorization: `Bearer ${regionToken}` };
    const extraToken = text(account && account[field]);
    if (headerName && extraToken) headers[headerName] = `Bearer ${extraToken}`;
    return headers;
  }
});

/**
 * 按描述符声明取该 provider 的鉴权头。
 * 未声明 relay.auth、或 kind 无实现时返回 `{}` —— 调用方保持原有行为，零开销。
 */
function resolveRelayAuthHeaders({ account, resolvedToken, auth } = {}) {
  const kind = text(auth && auth.kind);
  if (!kind) return {};
  const strategy = STRATEGIES[kind];
  if (typeof strategy !== 'function') return {};
  try {
    return strategy({ account, resolvedToken, auth }) || {};
  } catch (_error) {
    // 拼头失败不该让请求整体崩：返回空表，让上游按它自己的判断拒绝。
    return {};
  }
}

module.exports = {
  RELAY_AUTH_HEADER_STRATEGIES: STRATEGIES,
  resolveRelayAuthHeaders
};
