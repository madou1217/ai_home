'use strict';

// 把账号出口绑定解析成协议无关 target。这里只做读取、校验与调度，不启动代理
// 核心、不打开端口，也不修改系统网络。具体 target 由账号级 sidecar 转换成稳定的
// 127.0.0.1 endpoint，再交给 ZCode 原生 httpProxy。

const {
  EGRESS_MODE_GROUP,
  EGRESS_MODE_NODE,
  EGRESS_MODE_SYSTEM,
  EGRESS_MODE_TUN,
  EGRESS_MODE_URL
} = require('../account/zcode-egress-binding-store');
const { normalizeClientPlatform } = require('../runtime/client-platform');
const { detectSystemProxy } = require('../cli/services/toolkit/proxy-manager');
const { detectTun } = require('../cli/services/toolkit/system-network-manager');
const { selectZcodeEgressNode } = require('./zcode-egress-scheduler');

const SUPPORTED_PLATFORM = 'macos';
const ALLOWED_PROXY_SCHEMES = new Set([
  'http:',
  'https:',
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:'
]);

function fail(error, extra = {}) {
  return { ok: false, source: '', target: null, error, ...extra };
}

function normalizeProxyUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  if (!value.includes('://')) {
    const match = /^([^\s:/?#]+):(\d{1,5})$/.exec(value);
    if (!match) return '';
    const port = Number(match[2]);
    return port >= 1 && port <= 65535 ? value : '';
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return '';
  }
  if (!ALLOWED_PROXY_SCHEMES.has(parsed.protocol) || !parsed.hostname) return '';
  if (parsed.port) {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return '';
  }
  if (parsed.username || parsed.password) return '';
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) return '';
  return value;
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

function resolveZcodeEgressPlatform(input = {}) {
  return resolvePlatform(input).platform;
}

function resolveSystemProxyTarget(input, context) {
  const readSystemProxy = typeof input.detectSystemProxy === 'function'
    ? input.detectSystemProxy
    : () => detectSystemProxy({
      processObj: context.processObj,
      platform: context.rawPlatform
    });
  let status;
  try {
    status = readSystemProxy();
  } catch (error) {
    return fail('system_proxy_unavailable', {
      reason: String((error && error.message) || error || 'system_proxy_probe_failed')
    });
  }
  const proxyUrl = [status?.httpsProxy, status?.httpProxy, status?.socksProxy]
    .map(normalizeProxyUrl)
    .find(Boolean) || '';
  if (status?.enabled !== true || !proxyUrl) {
    return fail('system_proxy_unavailable', {
      probeStatus: String(status?.probeStatus || 'unknown')
    });
  }
  return {
    ok: true,
    source: EGRESS_MODE_SYSTEM,
    target: { kind: 'proxy-url', proxyUrl }
  };
}

function resolveTunTarget(input, context) {
  const readTun = typeof input.detectTun === 'function'
    ? input.detectTun
    : () => detectTun({ platform: context.rawPlatform });
  let tun;
  try {
    tun = readTun();
  } catch (error) {
    return fail('tun_state_unknown', {
      reason: String((error && error.message) || error || 'tun_probe_failed')
    });
  }
  const state = String(tun?.state || 'unknown').trim().toLowerCase();
  if (state !== 'active') {
    return fail(state === 'inactive' ? 'tun_inactive' : 'tun_state_unknown', { tun });
  }
  return {
    ok: true,
    source: EGRESS_MODE_TUN,
    target: { kind: 'direct' },
    tun
  };
}

function getNodeStore(input) {
  if (input.nodeStore) return input.nodeStore;
  const { getProxyNodeStore } = require('../cli/services/toolkit/proxy-pool/proxy-node-store');
  return getProxyNodeStore(input.nodeStoreOptions);
}

function resolveNodeTarget(binding, input) {
  const nodeId = String(binding.nodeId || '').trim();
  if (!nodeId) return fail('missing_node_id');
  let nodeStore;
  try {
    nodeStore = getNodeStore(input);
  } catch (error) {
    return fail('proxy_node_store_unavailable', {
      reason: String((error && error.message) || error || 'unknown')
    });
  }
  const node = nodeStore?.getNode?.(nodeId) || null;
  if (!node) return fail('proxy_node_not_found', { nodeId });
  return {
    ok: true,
    source: EGRESS_MODE_NODE,
    target: { kind: 'node', node },
    candidateNodes: [node],
    selectedNodeId: node.id
  };
}

function resolveGroupTarget(binding, input) {
  const groupId = String(binding.groupId || '').trim();
  if (!groupId) return fail('missing_group_id');
  let nodeStore;
  try {
    nodeStore = getNodeStore(input);
  } catch (error) {
    return fail('proxy_node_store_unavailable', {
      reason: String((error && error.message) || error || 'unknown')
    });
  }
  const group = nodeStore?.getGroup?.(groupId) || null;
  if (!group) return fail('proxy_group_not_found', { groupId });
  const nodes = nodeStore?.listNodes?.({ group: groupId }) || [];
  const leaseStore = input.leaseStore;
  const selection = selectZcodeEgressNode({
    group,
    nodes,
    leases: leaseStore?.listActive?.() || [],
    ownerId: String(input.ownerId || '').trim(),
    currentNodeId: String(input.currentNodeId || '').trim(),
    failedNodeIds: Array.isArray(input.failedNodeIds) ? input.failedNodeIds : [],
    lastSelectedNodeId: leaseStore?.getLastSelectedNodeId?.(groupId) || '',
    random: input.random
  });
  if (!selection.ok) return fail(selection.error, { groupId });
  return {
    ok: true,
    source: EGRESS_MODE_GROUP,
    target: { kind: 'node', node: selection.node },
    candidateNodes: nodes,
    selectedNodeId: selection.nodeId,
    groupId,
    selection
  };
}

async function resolveZcodeEgressTarget(input = {}) {
  const binding = input.binding;
  if (!binding) return fail('not_bound');
  const context = resolvePlatform(input);
  if (context.platform !== SUPPORTED_PLATFORM) {
    return fail('not_supported', { platform: context.platform });
  }

  if (binding.mode === EGRESS_MODE_SYSTEM) return resolveSystemProxyTarget(input, context);
  if (binding.mode === EGRESS_MODE_TUN) return resolveTunTarget(input, context);
  if (binding.mode === EGRESS_MODE_URL) {
    const proxyUrl = normalizeProxyUrl(binding.proxyUrl);
    if (!proxyUrl) return fail('invalid_proxy_url');
    return {
      ok: true,
      source: EGRESS_MODE_URL,
      target: { kind: 'proxy-url', proxyUrl }
    };
  }
  if (binding.mode === EGRESS_MODE_NODE) return resolveNodeTarget(binding, input);
  if (binding.mode === EGRESS_MODE_GROUP) return resolveGroupTarget(binding, input);
  return fail('unknown_egress_mode');
}

async function verifyResolvedProxy(proxyServer, source, probeProxyServer) {
  if (typeof probeProxyServer !== 'function') return { ok: true, proxyServer, source };
  let probe;
  try {
    probe = await probeProxyServer(proxyServer);
  } catch (error) {
    return {
      ok: false,
      proxyServer: '',
      source: '',
      error: 'proxy_unreachable',
      reason: String(error?.message || error || 'unknown')
    };
  }
  if (!probe || probe.ok !== true) {
    return {
      ok: false,
      proxyServer: '',
      source: '',
      error: 'proxy_unreachable',
      reason: String(probe?.reason || probe?.error || 'proxy_probe_failed')
    };
  }
  return { ok: true, proxyServer, source };
}

// 兼容已有调用方的薄适配器。完整 ZCode 链路应注入 ensureLocalEndpoint，使所有
// target 都先落到账号稳定回环端口；无 sidecar 时只有 URL 解析保持旧的纯值行为。
async function resolveZcodeEgress(input = {}) {
  const resolved = await resolveZcodeEgressTarget(input);
  if (!resolved.ok) {
    const { target: _target, ...failure } = resolved;
    return { proxyServer: '', ...failure };
  }
  if (typeof input.ensureLocalEndpoint === 'function') {
    let endpoint;
    try {
      endpoint = await input.ensureLocalEndpoint(resolved);
    } catch (error) {
      return {
        ok: false,
        proxyServer: '',
        source: '',
        error: 'sidecar_apply_failed',
        reason: String(error?.message || error || 'unknown')
      };
    }
    const proxyServer = String(endpoint?.proxyServer || '').trim();
    if (!endpoint?.ok || !proxyServer) {
      return {
        ok: false,
        proxyServer: '',
        source: '',
        error: String(endpoint?.error || 'sidecar_apply_failed'),
        ...(endpoint?.reason ? { reason: String(endpoint.reason) } : {})
      };
    }
    return verifyResolvedProxy(proxyServer, resolved.source, input.probeProxyServer);
  }
  if (resolved.target.kind === 'proxy-url') {
    return verifyResolvedProxy(
      resolved.target.proxyUrl,
      resolved.source,
      input.probeProxyServer
    );
  }
  return {
    ok: false,
    proxyServer: '',
    source: '',
    error: 'sidecar_unavailable'
  };
}

module.exports = {
  SUPPORTED_PLATFORM,
  normalizeProxyUrl,
  resolveZcodeEgress,
  resolveZcodeEgressPlatform,
  resolveZcodeEgressTarget
};
