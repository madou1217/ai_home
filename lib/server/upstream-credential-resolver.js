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
 * 判定依据是描述符声明的 jwtPlanKinds 与账号快照里的 planType 文案匹配
 * （例：planType 'ZCode Start Plan' 命中 'start-plan'）。
 * 这是数据驱动的匹配，不写 provider 名，也不写死具体套餐名。
 */
function isJwtPlanAccount(account, auth) {
  const kinds = Array.isArray(auth && auth.jwtPlanKinds) ? auth.jwtPlanKinds : [];
  if (kinds.length === 0) return false;
  // 判定面按可靠性排序：plan_id（事实）优先，展示名只作兜底。
  // 真机教训：phone 账号的展示名是 "ZCode 1024 Dev Day"，不含任何 start-plan 字样，
  // 只看展示名会判 false —— 而它的 plan_id 是 zcode-v3-start-plan-1024，一眼可判。
  const planIds = Array.isArray(account && account.planIds) ? account.planIds : [];
  const fallbackText = String(account && (account.planType || account.plan) || '').trim().toLowerCase();
  const haystacks = [
    ...planIds.map((id) => String(id || '').trim().toLowerCase()),
    fallbackText
  ].filter(Boolean);
  if (haystacks.length === 0) return false;
  return kinds.some((kind) => {
    const needle = String(kind || '').trim().toLowerCase();
    if (!needle) return false;
    // plan_id 用连字符（start-plan），展示名用空格（Start Plan），两种都认。
    const spaced = needle.replace(/-/g, ' ');
    return haystacks.some((text) => text.includes(needle) || text.includes(spaced));
  });
}

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
  if (auth.kind !== 'business_token') {
    return { accessToken: rawToken, resolved: false, reason: `relay_auth_kind_unsupported:${auth.kind}` };
  }
  // API Key 账号的凭据本身就是推理凭据，不需要（也不应该）拿去换业务 token。
  if (deps.apiKeyMode === true) return { accessToken: rawToken, resolved: false, reason: 'api_key_mode' };

  // 按套餐类型分叉（逆向桌面端 AccountProviderRequestAuthService）：
  //   start-plan 类套餐直接用**长期 jwt** 作推理凭据，不换取；
  //   只有 individual-coding-plan 才用 access_token 换 Project Access Token。
  // 用错形态会被上游按「凭据不对」拒绝，所以这里必须先判定套餐再决定。
  if (isJwtPlanAccount(account, auth)) {
    const jwt = String(account && (account.zcodeJwtToken || account.jwtToken) || '').trim();
    if (jwt) return { accessToken: jwt, resolved: true, reason: 'jwt_plan_direct' };
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
