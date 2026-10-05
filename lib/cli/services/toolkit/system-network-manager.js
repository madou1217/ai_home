'use strict';

const crypto = require('node:crypto');
const { detectSystemProxy } = require('./proxy-manager');
const { runCommand } = require('./system-proxy-plugins/os-command');
const { getSystemProxyPlugin } = require('./system-proxy-plugins');

function parseTunProcesses(text, options = {}) {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return { active: false, owner: null, evidence: [] };
  const ownedPid = Number(options.ownedPid);
  if (Number.isInteger(ownedPid) && ownedPid > 0) {
    const ownedProcess = String(text || '').split(/\r?\n/).find((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      return match && Number(match[1]) === ownedPid && /mihomo|clash-meta|sing-box/i.test(match[2]);
    });
    if (ownedProcess) {
      const engine = /sing-box/i.test(ownedProcess) ? 'sing-box' : 'mihomo';
      return { active: true, owner: 'aih', evidence: [`process:aih-${engine}`] };
    }
  }
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
  const process = parseTunProcesses(outputs.processOutput, { ownedPid: options.ownedPid });
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
  const externalTun = tun.state === 'active' && tun.owner !== 'aih';
  return {
    platform,
    systemProxy,
    tun,
    effectiveRoute,
    effectiveRouteKnown: effectiveRoute !== 'direct-unknown' && effectiveRoute !== 'unknown',
    takeoverAllowed: !externalTun,
    conflicts: externalTun ? [`external_tun_active:${tun.owner || 'unknown'}`] : []
  };
}

function hashSnapshot(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex');
}

function parseProxyUrl(proxyUrl) {
  try {
    const url = new URL(String(proxyUrl || ''));
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || url.username || url.password) return null;
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return null;
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { protocol: url.protocol, host: url.hostname, port };
  } catch (_error) {
    return null;
  }
}

// 读取宿主平台的可回滚系统代理快照，返回规划所需的 current（平台差异由插件处理）。
function readSystemProxyCurrent(service, options = {}) {
  const plugin = getSystemProxyPlugin(options.platform || process.platform);
  if (!plugin) return { ok: false, error: 'system_proxy_platform_unsupported' };
  const snapshot = plugin.readSnapshot(service, options);
  if (!snapshot.ok) return snapshot;
  return { ok: true, current: plugin.currentFromSnapshot(snapshot) };
}

function planSystemProxy(input = {}) {
  const platform = String(input.platform || process.platform).toLowerCase();
  const proxy = parseProxyUrl(input.proxyUrl);
  if (input.action !== 'enable' && input.action !== 'disable' && input.action !== 'restore') {
    return { ok: false, error: 'unsupported_system_proxy_action' };
  }
  if (input.action === 'enable' && !proxy) return { ok: false, error: 'invalid_local_proxy_url' };
  if (input.network?.tun?.state === 'active' && input.network.tun.owner !== 'aih') {
    return { ok: false, error: 'external_tun_active' };
  }
  const service = String(input.service || '').trim();
  const plugin = getSystemProxyPlugin(platform);
  if (plugin?.requiresService && !service) return { ok: false, error: 'network_service_required' };
  if (!plugin) return { ok: false, error: 'system_proxy_platform_unsupported' };
  const current = input.current || {};
  const context = { service, proxy, current };
  const operationsByAction = {
    enable: () => plugin.enableOperations(context),
    disable: () => plugin.disableOperations(context),
    restore: () => plugin.restoreOperations(context)
  };
  const snapshot = plugin.snapshotFor(context);
  return {
    ok: true,
    plan: {
      platform,
      action: input.action,
      service,
      proxyUrl: input.proxyUrl || null,
      snapshot,
      snapshotHash: hashSnapshot(snapshot),
      operations: operationsByAction[input.action](),
      rollbackOperations: plugin.restoreOperations(context)
    }
  };
}

async function executeSystemProxyPlan(plan, options = {}) {
  if (options.confirmed !== true) return { ok: false, error: 'confirmation_required' };
  if (!plan || !plan.snapshotHash || options.expectedSnapshotHash !== plan.snapshotHash) {
    return { ok: false, error: 'system_proxy_snapshot_changed' };
  }
  const run = options.execCommand || ((commandName, args) => runCommand(options, commandName, args));
  const operations = [];
  for (const operation of plan.operations || []) {
    const result = run(operation.command, operation.args);
    const item = { key: operation.key, ok: result?.status === 0 || result?.ok === true, exitCode: result?.status ?? null };
    operations.push(item);
    if (!item.ok) {
      let rollbackApplied = true;
      for (const rollback of plan.rollbackOperations || []) {
        const rollbackResult = run(rollback.command, rollback.args);
        if (!(rollbackResult?.status === 0 || rollbackResult?.ok === true)) rollbackApplied = false;
      }
      return {
        ok: false,
        error: rollbackApplied ? 'system_proxy_rollback_applied' : 'system_proxy_rollback_failed',
        rollbackApplied,
        operations
      };
    }
  }
  return { ok: true, applied: true, operations };
}

module.exports = {
  detectNetworkLayer,
  detectTun,
  executeSystemProxyPlan,
  hashSnapshot,
  parseProxyUrl,
  planSystemProxy,
  readSystemProxyCurrent
};
