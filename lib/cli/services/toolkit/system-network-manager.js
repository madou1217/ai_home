'use strict';

const { detectSystemProxy } = require('./proxy-manager');
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

module.exports = {
  detectNetworkLayer,
  detectTun
};
