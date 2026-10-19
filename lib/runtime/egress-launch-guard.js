'use strict';

// 启动守卫（CLI / 桌面 / WebUI 原生会话）：本地启动的原生客户端直接连上游，不经网关，
// 所以网关的网络守卫管不到它们。这里在构造启动环境时同步判定一次：
//   出口 = 账号出口（代理地址）/ TUN（直连）/ 未绑定时继承的环境代理 / 直连；
//   上游 = 环境里指向的接口地址（*_BASE_URL，非回环）或该 provider 的官方上游；
//         指向本机网关（回环）时跳过 —— 请求由网关出网，网关守卫负责。
// 走出口池的账号不经这里（车道只放行判定允许的节点）。
// 被拒 → 抛 account_egress_region_denied（带可读原因），启动链据此中止并提示用户设置出口。

const nodeFs = require('node:fs');

const {
  describeNetworkDenial,
  evaluateNetworkExit,
  getExitGeoSync
} = require('./egress-network-guard');

const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'];

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isLoopbackUrl(value) {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch (_error) {
    return false;
  }
}

/**
 * 环境里客户端会用的接口地址：任意 *_BASE_URL（provider 无关）。
 * AIH_* 是 aih 自己注入的协作地址（例如 AIH_GATEWAY_BASE_URL 指向本机网关，供跨 provider 协作技能用），
 * 不是客户端的上游，不计入 —— 否则每次启动都会被误判为「经网关」而跳过守卫。
 */
function readEnvBaseUrls(env) {
  return Object.entries(env || {})
    .filter(([key, value]) => !/^AIH_/i.test(key) && /_BASE_URL$/i.test(key) && /^https?:\/\//i.test(normalizeString(value)))
    .map(([, value]) => normalizeString(value));
}

// 与网关同一套默认上游（例如 codex OAuth → chatgpt.com），保证 CLI 与网关查到的是同一份上游策略。
let defaultServerOptions = null;
function serverDefaults() {
  if (!defaultServerOptions) {
    try {
      // eslint-disable-next-line global-require
      defaultServerOptions = require('../server/args').parseServerServeArgs([]);
    } catch (_error) {
      defaultServerOptions = {};
    }
  }
  return defaultServerOptions;
}

/**
 * @param {object} input { env, provider, accountRef, egress: { bound, direct?, proxyUrl, source? }, fs, aiHomeDir }
 * @returns {null | { reason: string, verdict: object, upstream: object }} null = 放行
 */
function checkLaunchNetwork(input = {}) {
  const egress = input.egress || {};
  if (egress.source === 'pool') return null;
  const env = input.env || {};
  const baseUrls = readEnvBaseUrls(env);
  if (baseUrls.some(isLoopbackUrl)) return null;
  // eslint-disable-next-line global-require
  const { readUpstreamDecisionContext, resolveAccountUpstream } = require('../server/egress-upstream');
  const relay = baseUrls[0] || '';
  const upstream = resolveAccountUpstream(input.serverOptions || serverDefaults(), relay
    ? { provider: input.provider, accountRef: input.accountRef, apiKeyMode: true, baseUrl: relay, openaiBaseUrl: relay }
    : { provider: input.provider, accountRef: input.accountRef });
  if (!upstream) return null;
  const fs = input.fs || nodeFs;
  const context = readUpstreamDecisionContext(fs, input.aiHomeDir, upstream);
  if (!context || (context.policy.rules.length === 0 && context.hints.length === 0)) return null;
  let proxyUrl = '';
  if (egress.bound) proxyUrl = egress.direct ? '' : normalizeString(egress.proxyUrl);
  else proxyUrl = PROXY_KEYS.map((key) => normalizeString(env[key])).find(Boolean) || '';
  const lookup = typeof input.lookupSync === 'function' ? input.lookupSync : getExitGeoSync;
  const geo = lookup({ fs, aiHomeDir: input.aiHomeDir, proxyUrl });
  const verdict = evaluateNetworkExit(context, geo);
  if (!verdict || verdict.status !== 'denied') return null;
  return { reason: describeNetworkDenial(verdict, upstream.id), verdict, upstream };
}

module.exports = {
  checkLaunchNetwork,
  readEnvBaseUrls
};
