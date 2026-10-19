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
  getExitGeo
} = require('../runtime/egress-network-guard');

const CONTEXT_CACHE_MS = 10 * 1000;

let configured = null;
const contextCache = new Map();

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
  invalidateGatewayNetworkGuard
};
