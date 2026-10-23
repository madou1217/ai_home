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

/** 异步版网络层判定：系统代理与 TUN 探测并发。 */
async function detectNetworkLayerAsync(options = {}) {
  const platform = String(options.platform || process.platform).toLowerCase();
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
  detectNetworkLayer,
  detectNetworkLayerAsync,
  detectTun,
  detectTunAsync
};
