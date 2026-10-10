'use strict';

// 把账号出口绑定解析成交给客户端的代理目标。AIH 不运行代理内核、不开本地端口：
// url / system 模式直接使用外部 HTTP(S) 代理，tun 模式交给外部 TUN（客户端直连）。
// 这里只做读取、校验与探测结果缓存，不修改系统网络。

const {
  EGRESS_MODE_SYSTEM,
  EGRESS_MODE_TUN,
  EGRESS_MODE_URL
} = require('../account/zcode-egress-binding-store');
const { normalizeClientPlatform } = require('../runtime/client-platform');
const { detectSystemProxy } = require('../cli/services/toolkit/proxy-manager');
const { detectTun } = require('../cli/services/toolkit/system-network-manager');

const SUPPORTED_PLATFORM = 'macos';
// 网关请求、CLI 代理环境变量、Chromium 与 ZCode 原生设置只能可靠地消费 HTTP(S) 代理；
// socks 地址在网关请求路径上会被静默当成直连，所以在入口直接拒绝。
const ALLOWED_PROXY_SCHEMES = new Set(['http:', 'https:']);
// 系统代理与 TUN 探测要起子进程（scutil / ifconfig / netstat / ps）。调用方显式要求时
// （网关请求热路径）按「探测函数 + 平台」复用短期结果；注入的探测函数各自独立缓存。
const DETECTION_CACHE_TTL_MS = 15 * 1000;
let detectionCache = new WeakMap();

function fail(error, extra = {}) {
  return { ok: false, source: '', target: null, error, ...extra };
}

/**
 * 代理地址的问题：'' 表示合法；否则返回错误码。
 * 允许 http(s)://host:port 与 host:port 简写；不允许凭据、路径、查询串。
 */
function proxyUrlIssue(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return 'invalid_proxy_url';
  if (!value.includes('://') && !/^[^\s:/?#]+:\d{1,5}$/.test(value)) return 'invalid_proxy_url';
  let parsed;
  try {
    parsed = new URL(value.includes('://') ? value : `http://${value}`);
  } catch {
    return 'invalid_proxy_url';
  }
  if (!ALLOWED_PROXY_SCHEMES.has(parsed.protocol)) return 'proxy_scheme_unsupported';
  if (!parsed.hostname || parsed.port === '0' || parsed.username || parsed.password) return 'invalid_proxy_url';
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) return 'invalid_proxy_url';
  return '';
}

/** 归一化成完整的 http(s)://host:port；不合法返回 ''。 */
function normalizeProxyUrl(rawUrl) {
  if (proxyUrlIssue(rawUrl)) return '';
  const value = String(rawUrl).trim();
  const parsed = new URL(value.includes('://') ? value : `http://${value}`);
  return `${parsed.protocol}//${parsed.host}`;
}

function resolvePlatform(input) {
  const processObj = input.processObj || process;
  const rawPlatform = input.platform !== undefined ? input.platform : processObj.platform;
  return {
    platform: normalizeClientPlatform(rawPlatform),
    rawPlatform,
    processObj
  };
}

function detectWithCache(detector, context, input) {
  const run = () => detector({ processObj: context.processObj, platform: context.rawPlatform });
  if (input.useDetectionCache !== true) return run();
  const now = typeof input.now === 'function' ? Number(input.now()) : Date.now();
  let entries = detectionCache.get(detector);
  if (!entries) {
    entries = new Map();
    detectionCache.set(detector, entries);
  }
  const cacheKey = String(context.rawPlatform);
  const cached = entries.get(cacheKey);
  if (cached && now - cached.at < DETECTION_CACHE_TTL_MS) return cached.value;
  const value = run();
  entries.set(cacheKey, { at: now, value });
  return value;
}

function resolveSystemProxyTarget(input, context) {
  const detector = typeof input.detectSystemProxy === 'function' ? input.detectSystemProxy : detectSystemProxy;
  let status;
  try {
    status = detectWithCache(detector, context, input);
  } catch (error) {
    return fail('system_proxy_unavailable', {
      reason: String((error && error.message) || error || 'system_proxy_probe_failed')
    });
  }
  if (status?.enabled !== true) {
    return fail('system_proxy_unavailable', { probeStatus: String(status?.probeStatus || 'unknown') });
  }
  const proxyUrl = [status.httpsProxy, status.httpProxy].map(normalizeProxyUrl).find(Boolean) || '';
  if (!proxyUrl) {
    return fail(status.socksProxy ? 'system_proxy_http_unavailable' : 'system_proxy_unavailable', {
      probeStatus: String(status.probeStatus || 'unknown')
    });
  }
  return { ok: true, source: EGRESS_MODE_SYSTEM, target: { kind: 'proxy-url', proxyUrl } };
}

function resolveTunTarget(input, context) {
  const detector = typeof input.detectTun === 'function' ? input.detectTun : detectTun;
  let tun;
  try {
    tun = detectWithCache(detector, context, input);
  } catch (error) {
    return fail('tun_state_unknown', {
      reason: String((error && error.message) || error || 'tun_probe_failed')
    });
  }
  const state = String(tun?.state || 'unknown').trim().toLowerCase();
  if (state !== 'active') {
    return fail(state === 'inactive' ? 'tun_inactive' : 'tun_state_unknown', { tun });
  }
  return { ok: true, source: EGRESS_MODE_TUN, target: { kind: 'direct' }, tun };
}

/**
 * 同步解析绑定 → { ok, source, target: {kind:'proxy-url', proxyUrl} | {kind:'direct'} }。
 * 失败一律返回错误码，由调用方 fail-closed（不回落到全局代理或直连）。
 */
function resolveEgressTarget(input = {}) {
  const binding = input.binding;
  if (!binding) return fail('not_bound');
  if (binding.retired) return fail('account_egress_mode_retired', { mode: binding.mode });
  const context = resolvePlatform(input);
  if (context.platform !== SUPPORTED_PLATFORM) {
    return fail('not_supported', { platform: context.platform });
  }
  if (binding.mode === EGRESS_MODE_SYSTEM) return resolveSystemProxyTarget(input, context);
  if (binding.mode === EGRESS_MODE_TUN) return resolveTunTarget(input, context);
  if (binding.mode === EGRESS_MODE_URL) {
    const issue = proxyUrlIssue(binding.proxyUrl);
    if (issue) return fail(issue);
    return {
      ok: true,
      source: EGRESS_MODE_URL,
      target: { kind: 'proxy-url', proxyUrl: normalizeProxyUrl(binding.proxyUrl) }
    };
  }
  return fail('unknown_egress_mode');
}

function clearEgressDetectionCache() {
  detectionCache = new WeakMap();
}

module.exports = {
  DETECTION_CACHE_TTL_MS,
  SUPPORTED_PLATFORM,
  clearEgressDetectionCache,
  normalizeProxyUrl,
  proxyUrlIssue,
  resolveEgressTarget
};
