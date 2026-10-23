'use strict';

const { detectSystemProxy, detectSystemProxyAsync } = require('./proxy-manager');
const { getSystemProxyPlugin } = require('./system-proxy-plugins');

function parseTunProcesses(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return { active: false, owner: null, evidence: [] };
  if (/clash[- ]?verge|verge[- ]mihomo/.test(lower)) return { active: true, owner: 'clash-verge', evidence: ['process:clash-verge'] };
  if (/mihomo|clash-meta/.test(lower)) return { active: true, owner: 'mihomo', evidence: ['process:mihomo'] };
  if (/sing-box|singbox/.test(lower)) return { active: true, owner: 'sing-box', evidence: ['process:sing-box'] };
  return { active: true, owner: 'external', evidence: ['process:network-core'] };
}

function detectTun(options = {}) {
  const platform = String(options.platform || process.platform).toLowerCase();
  const plugin = getSystemProxyPlugin(platform);
  const outputs = plugin
    ? plugin.tun.probe(options)
    : { interfaceOutput: '', routeOutput: '', processOutput: '' };
  const process = parseTunProcesses(outputs.processOutput);
  const interfaceMatch = Boolean(plugin && plugin.tun.interfaceDetected(outputs));
  const routeMatch = Boolean(plugin && plugin.tun.routeDetected(outputs));
  const active = Boolean(interfaceMatch && (routeMatch || process.active));
  return {
    state: active ? 'active' : (interfaceMatch || routeMatch ? 'unknown' : 'inactive'),
    owner: active ? process.owner : null,
    interfaceDetected: interfaceMatch,
    routeDetected: routeMatch,
    evidence: [...new Set([
      ...(interfaceMatch ? ['interface'] : []),
      ...(routeMatch ? ['route'] : []),
      ...process.evidence
    ])]
  };
}

function detectNetworkLayer(options = {}) {
  const platform = String(options.platform || process.platform).toLowerCase();
  const systemProxy = options.systemProxy || detectSystemProxy({ ...options, platform });
  const tun = options.tun || detectTun({ ...options, platform });
  const effectiveRoute = tun.state === 'active'
    ? 'tun'
    : systemProxy.enabled
      ? 'system-proxy'
        : tun.state === 'unknown'
          ? 'unknown'
          : 'direct-unknown';
  return {
    platform,
    systemProxy,
    tun,
    effectiveRoute,
    effectiveRouteKnown: effectiveRoute !== 'direct-unknown' && effectiveRoute !== 'unknown'
  };
}

/** 异步版 TUN 探测：三条命令并发跑。 */
async function detectTunAsync(options = {}) {
  const platform = String(options.platform || process.platform).toLowerCase();
  const plugin = getSystemProxyPlugin(platform);
  if (!plugin) return { state: 'inactive', owner: null, interfaceDetected: false, routeDetected: false, evidence: [] };
  const { runCommandAsync } = require('./system-proxy-plugins/os-command');
  const [interfaceRes, routeRes, processRes] = await Promise.all([
    runCommandAsync(options, 'ifconfig'),
    runCommandAsync(options, 'netstat', ['-rn']),
    runCommandAsync(options, 'ps', ['-axo', 'pid=,command='])
  ]);
  const outputs = {
    interfaceOutput: String(interfaceRes.stdout || ''),
    routeOutput: String(routeRes.stdout || ''),
    processOutput: String(processRes.stdout || '')
  };
  const processInfo = parseTunProcesses(outputs.processOutput);
  const interfaceMatch = Boolean(plugin.tun.interfaceDetected(outputs));
  const routeMatch = Boolean(plugin.tun.routeDetected(outputs));
  const active = Boolean(interfaceMatch && (routeMatch || processInfo.active));
  return {
    state: active ? 'active' : (interfaceMatch || routeMatch ? 'unknown' : 'inactive'),
    owner: active ? processInfo.owner : null,
    interfaceDetected: interfaceMatch,
    routeDetected: routeMatch,
    evidence: [...new Set([
      ...(interfaceMatch ? ['interface'] : []),
      ...(routeMatch ? ['route'] : []),
      ...processInfo.evidence
    ])]
  };
}

// 网络层判定要跑 ifconfig / netstat / ps / scutil / networksetup（实测 ~320ms），
// 而「当前走 TUN 还是系统代理」秒级内不会变。WebUI 每次进代理诊断面板都会问一次，
// 缓存住以免同一份结论被反复重算。
const NETWORK_LAYER_TTL_MS = 10 * 1000;
let networkLayerCache = null;
let networkLayerInFlight = null;

function clearNetworkLayerCache() {
  networkLayerCache = null;
  networkLayerInFlight = null;
}

/** 异步版网络层判定：系统代理与 TUN 探测并发。 */
// 见 detectNetworkLayerAsync 里的说明：判定注入要按「实现是否不同源」，不按键是否存在。
function isCacheableNetworkLayerCall(options = {}) {
  const { spawn, spawnSync } = require('node:child_process');
  if (options.spawnSync && options.spawnSync !== spawnSync) return false;
  if (options.spawn && options.spawn !== spawn) return false;
  if (options.processObj && options.processObj !== process) return false;
  if (options.env && options.env !== process.env) return false;
  if (options.execCommand && typeof options.execCommand === 'function') return false;
  if (options.execCommandAsync && typeof options.execCommandAsync === 'function') return false;
  return true;
}

async function detectNetworkLayerAsync(options = {}) {
  const platform = String(options.platform || process.platform).toLowerCase();
  // 注入式调用（测试 / 显式传 systemProxy、tun）不走缓存，保证可预期。
  // 只有不带注入的常规调用��走缓存（测试会注入 execCommandAsync / processObj 构造环境）。
  // 只认「显式注入的非本机实现」：WebUI 路由会把整个请求上下文展开传进来
  // （buildToolkitOptions 里 `...ctx, ...deps`），按「键是否存在」判断会让生产缓存永不生效。
  const cacheable = !options.systemProxy && !options.tun && isCacheableNetworkLayerCall(options);
  if (cacheable) {
    const now = Date.now();
    const cached = networkLayerCache;
    if (cached) {
      // 有旧值就先回旧值（附 stale 标记），同时后台刷新。
      // 冷启动也达标的要求下不能让首次请求干等 300ms+ 的子进程。
      if (now - cached.at >= NETWORK_LAYER_TTL_MS) {
        refreshNetworkLayerAsync(options, platform).catch(() => {});
        return { ...cached.value, stale: true };
      }
      return cached.value;
    }
    return refreshNetworkLayerAsync(options, platform);
  }
  return detectNetworkLayerUncached(options, platform);
}

function refreshNetworkLayerAsync(options = {}, platform = '') {
  if (networkLayerInFlight) return networkLayerInFlight;
  const request = detectNetworkLayerUncached(options, platform)
    .then((value) => {
      networkLayerCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      if (networkLayerInFlight === request) networkLayerInFlight = null;
    });
  networkLayerInFlight = request;
  return request;
}

async function detectNetworkLayerUncached(options = {}, platform = '') {
  const [systemProxy, tun] = await Promise.all([
    options.systemProxy
      ? Promise.resolve(options.systemProxy)
      : detectSystemProxyAsync({ ...options, platform }),
    options.tun ? Promise.resolve(options.tun) : detectTunAsync({ ...options, platform })
  ]);
  const effectiveRoute = tun.state === 'active'
    ? 'tun'
    : systemProxy.enabled
      ? 'system-proxy'
      : tun.state === 'unknown'
        ? 'unknown'
        : 'direct-unknown';
  return {
    platform,
    systemProxy,
    tun,
    effectiveRoute,
    effectiveRouteKnown: effectiveRoute !== 'direct-unknown' && effectiveRoute !== 'unknown'
  };
}

module.exports = {
  clearNetworkLayerCache,
  detectNetworkLayer,
  detectNetworkLayerAsync,
  detectTun,
  detectTunAsync
};
