'use strict';

// 网关侧的当前网络守卫（见 runtime/egress-network-guard）：账号不走出口池时，attempt 的实际出口
// （账号出口改写后的代理 / 全局代理 / 环境代理 / 直连）对该账号上游是否被拒。被拒 → 本次 attempt
// fail-closed（不记账号失败，换下一个账号），错误详情告诉用户去设置出口。
//
// 账号记录（推导上游要用 apiKeyMode / baseUrl）与 server 选项由组合根 configure() 注入；
// 未注入（单测 / 纯协议嵌入）时守卫不生效，行为与之前完全一致。

const { resolveProxyConfig } = require('./http-utils-utils');
const { readUpstreamDecisionContext, resolveAccountUpstream } = require('./egress-upstream');
const {
  describeNetworkDenial,
  evaluateNetworkExit,
  getExitGeo,
  peekExitGeo,
  refreshExitGeo
} = require('../runtime/egress-network-guard');
const { listAccountEgressBindings } = require('../account/zcode-egress-binding-store');

const CONTEXT_CACHE_MS = 10 * 1000;
const DENIED_REFS_CACHE_MS = 5 * 1000;

let configured = null;
const contextCache = new Map();
let deniedRefsCache = null;

/** deps: { fs, aiHomeDir, getAccount(accountRef), getServerOptions() }；传 null 注销。 */
function configureGatewayNetworkGuard(deps) {
  configured = deps && typeof deps === 'object' ? deps : null;
  contextCache.clear();
}

function cachedContext(fs, aiHomeDir, upstream) {
  const hit = contextCache.get(upstream.id);
  if (hit && Date.now() - hit.at < CONTEXT_CACHE_MS) return hit.context;
  const context = readUpstreamDecisionContext(fs, aiHomeDir, upstream);
  contextCache.set(upstream.id, { context, at: Date.now() });
  return context;
}

/** 上游策略 / 实测变了（WebUI 写入）：立即失效缓存。 */
function invalidateGatewayNetworkGuard() {
  contextCache.clear();
  deniedRefsCache = null;
}

/**
 * 当前网络被上游拒绝的账号集合（同步，只读缓存的出口位置；缺位置时后台刷新）。
 * Go Core 没有这道守卫：server 把它并进「必须交还 Node」的账号集合（go-core-route-deferral），
 * 这些账号的请求因此由 Node 承接并被守卫排除，而不是被 Go 直接打到上游。
 */
function listNetworkDeniedRefs() {
  if (!configured) return new Set();
  if (deniedRefsCache && Date.now() - deniedRefsCache.at < DENIED_REFS_CACHE_MS) return deniedRefsCache.refs;
  const refs = new Set();
  try {
    const bindings = new Map();
    listAccountEgressBindings(configured.fs, configured.aiHomeDir).forEach((entry) => bindings.set(entry.accountRef, entry.binding));
    const serverOptions = (typeof configured.getServerOptions === 'function' && configured.getServerOptions()) || {};
    const pools = (typeof configured.getPools === 'function' && configured.getPools()) || {};
    Object.values(pools).forEach((pool) => (Array.isArray(pool) ? pool : []).forEach((account) => {
      const binding = bindings.get(account && account.accountRef);
      // 出口池 / 自定义地址 / 系统代理的账号本来就交还 Node（并由各自路径判定）；这里只看会被 Go 承接的。
      if (binding && binding.mode !== 'tun') return;
      const upstream = resolveAccountUpstream(serverOptions, account);
      if (!upstream) return;
      const context = cachedContext(configured.fs, configured.aiHomeDir, upstream);
      if (!context || (context.policy.rules.length === 0 && context.hints.length === 0)) return;
      const proxyUrl = binding && binding.mode === 'tun' ? '' : resolveProxyConfig(upstream.baseUrl, serverOptions).url;
      const geo = peekExitGeo({ fs: configured.fs, aiHomeDir: configured.aiHomeDir, proxyUrl });
      if (!geo || geo.stale) refreshExitGeo({ fs: configured.fs, aiHomeDir: configured.aiHomeDir, proxyUrl }).catch(() => {});
      const verdict = evaluateNetworkExit(context, geo);
      if (verdict && verdict.status === 'denied') refs.add(account.accountRef);
    }));
  } catch (_error) {
    /* 读不出来：不额外交还（出口绑定索引仍按自己的规则保守） */
  }
  deniedRefsCache = { refs, at: Date.now() };
  return refs;
}

/**
 * @returns {Promise<null | { denied: true, error: string, reason: string, verdict, upstream }>}
 *   null = 放行（未配置 / 走出口池 / 该上游无地区规则 / 判定非 denied）。永不抛。
 */
async function checkGatewayNetwork(input = {}) {
  if (!configured) return null;
  try {
    if (String(input.egressSource || '') === 'pool') return null;
    const accountRef = String(input.accountRef || '').trim();
    const provider = String(input.provider || '').trim().toLowerCase();
    if (!accountRef || !provider) return null;
    const account = (typeof configured.getAccount === 'function' && configured.getAccount(accountRef)) || { accountRef, provider };
    const serverOptions = (typeof configured.getServerOptions === 'function' && configured.getServerOptions()) || {};
    const upstream = resolveAccountUpstream(serverOptions, account);
    if (!upstream) return null;
    const context = cachedContext(configured.fs, configured.aiHomeDir, upstream);
    if (!context || (context.policy.rules.length === 0 && context.hints.length === 0)) return null;
    const attemptOptions = input.options || {};
    const proxyUrl = attemptOptions.noProxy === '*' ? '' : resolveProxyConfig(upstream.baseUrl, attemptOptions).url;
    const geo = await getExitGeo({ fs: configured.fs, aiHomeDir: configured.aiHomeDir, proxyUrl });
    const verdict = evaluateNetworkExit(context, geo);
    if (!verdict || verdict.status !== 'denied') return null;
    return {
      denied: true,
      error: 'egress_region_denied',
      reason: describeNetworkDenial(verdict, upstream.id),
      verdict,
      upstream
    };
  } catch (_error) {
    return null;
  }
}

module.exports = {
  checkGatewayNetwork,
  configureGatewayNetworkGuard,
  invalidateGatewayNetworkGuard,
  listNetworkDeniedRefs
};
