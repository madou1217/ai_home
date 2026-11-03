'use strict';

// relay 推理凭据的**唯一解析门面**：把账号的登录态凭据换成上游真正接受的推理凭据。
//
// 为什么需要（2026-10-24 取证）：有些 provider 的 OAuth 登录态 access_token
// **不能直接用于推理**。桌面端在发推理请求前先把它换成业务 token
// （例：zcode 的 POST api.z.ai/api/auth/z/login → PAT）。不做这一步，上游返回
// `3012 unusual activity` / `1005 exceed quota limit` —— 看起来像风控，
// 其实是**用错了凭据**。
//
// 设计纪律（AGENTS.md）：
//   * 谁需要换、换成什么，由 provider 描述符声明（`capabilities.relay.auth`）；
//     本模块按能力倒排取声明，**不写 `if (provider === 'zcode')`**。
//   * 未声明 `relay.auth` 的 provider → 原样返回凭据（零开销直通）。
//   * API Key 账号本来就用推理凭据，同样直通。
//   * 换取的失败一律 fail-closed（抛错由调用方按账号失败处理），
//     绝不静默回退成「用未换取的凭据发出去」—— 那正是产生 3012 的路径。

const { getProviderCapability } = require('../providers');
const { createBusinessTokenResolver } = require('./business-token-resolver');
// 「长期 jwt 直通」套餐的判定唯一实现处（relay-auth-headers 共用同一份）。
const { isJwtPlanAccount } = require('./relay-auth-plan-kind');

// 每个 (provider, loginUrl) 一个解析器实例：缓存与单飞都在实例内，
// 不同 provider / 不同登录端点互不串味。
const resolvers = new Map();

function resolveRelayAuthDeclaration(provider) {
  let relay = null;
  try {
    relay = getProviderCapability(provider, 'relay');
  } catch (_error) {
    relay = null;
  }
  const auth = relay && typeof relay === 'object' ? relay.auth : null;
  return auth && typeof auth === 'object' && auth.kind ? auth : null;
}

/**
 * 该账号是否属于「直接用长期 jwt 推理」的套餐类型。
 * 实现已移到 relay-auth-plan-kind（relay-auth-headers 共用同一份判定）；
 * 这里保留再导出，维持既有调用方（test/源码扫描）的接口不变。
 */
// isJwtPlanAccount 由 relay-auth-plan-kind 提供（见文件头 require）。

function resolverFor(provider, auth, deps = {}) {
  const key = `${provider}:${auth.kind}:${auth.loginUrl}`;
  let resolver = resolvers.get(key);
  if (resolver) return resolver;
  const request = typeof deps.request === 'function' ? deps.request : null;
  if (!request) return null;
  resolver = createBusinessTokenResolver({
    loginUrl: auth.loginUrl,
    request,
    timeoutMs: deps.timeoutMs,
    now: deps.now
  });
  resolvers.set(key, resolver);
  return resolver;
}

/**
 * 把账号凭据解析成可用于推理的凭据。
 *
 * @returns {Promise<{accessToken: string, resolved: boolean, reason: string}>}
 *   resolved=false 表示该 provider 不需要换取（直通），reason 说明原因。
 * @throws 换取失败时抛错（fail-closed），错误码由 resolver 给出。
 */
async function resolveRelayCredential(account, deps = {}) {
  const provider = String(account && account.provider || '').trim().toLowerCase();
  const rawToken = String(account && account.accessToken || '').trim();
  if (!provider) return { accessToken: rawToken, resolved: false, reason: 'provider_missing' };
  if (!rawToken) return { accessToken: '', resolved: false, reason: 'credential_missing' };

  const auth = resolveRelayAuthDeclaration(provider);
  if (!auth) return { accessToken: rawToken, resolved: false, reason: 'relay_auth_not_declared' };
  // API Key 账号的凭据本身就是推理凭据，不需要（也不应该）拿去换业务 token。
  if (deps.apiKeyMode === true) return { accessToken: rawToken, resolved: false, reason: 'api_key_mode' };

  // 按套餐类型分叉（逆向桌面端 AccountProviderRequestAuthService）：
  //   start-plan 类套餐直接用**长期 jwt** 作推理凭据，不换取；
  //   只有 individual-coding-plan 才用 access_token 换 Project Access Token。
  // 用错形态会被上游按「凭据不对」拒绝，所以这里必须先判定套餐再决定。
  //
  // **这一步必须先于 kind 检查**：kind 描述的是「鉴权头怎么拼」（单头 / 双头），
  // 与「用哪个凭据」是两件正交的事。真机教训（2026-10-27）：zcode 的 kind 是
  // business_token_pair，若先按 kind 分流，这里会以
  // `relay_auth_kind_unsupported:business_token_pair` 直接放行 raw access_token ——
  // 而这类账号的 access_token 早已过期且没有 refresh_token，于是请求带着过期凭据
  // 打到只认 jwt 的 zcode-plan 端点，得到 401（空正文）→ 被判 auth_invalid（1 年冷却）。
  if (isJwtPlanAccount(account, auth)) {
    const jwtField = String((auth && auth.extraTokenField) || '').trim() || 'zcodeJwtToken';
    const jwt = String(account && (account[jwtField] || account.jwtToken) || '').trim();
    if (jwt) return { accessToken: jwt, resolved: true, reason: 'jwt_plan_direct' };
  }

  if (auth.kind !== 'business_token') {
    return { accessToken: rawToken, resolved: false, reason: `relay_auth_kind_unsupported:${auth.kind}` };
  }

  const resolver = resolverFor(provider, auth, deps);
  if (!resolver) return { accessToken: rawToken, resolved: false, reason: 'resolver_unavailable' };

  const accessToken = await resolver.resolve(rawToken);
  return { accessToken, resolved: true, reason: 'business_token' };
}

/** 清空缓存（账号凭据变更 / 测试用）。 */
function resetRelayCredentialResolvers() {
  for (const resolver of resolvers.values()) resolver.clear();
  resolvers.clear();
}

module.exports = {
  isJwtPlanAccount,
  resolveRelayAuthDeclaration,
  resolveRelayCredential,
  resetRelayCredentialResolvers
};
