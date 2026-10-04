'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const {
  SUPPORTED_PROTOCOLS,
  isValidPort,
  normalizeProtocol
} = require('../cli/services/toolkit/proxy-pool/proxy-protocol-contract');
const {
  normalizeServerHost
} = require('../cli/services/toolkit/proxy-pool/protocol-parsers/base-parser');
const { getProtocolPlugin } = require('../cli/services/toolkit/proxy-pool/protocols');
const {
  configError,
  requiredString
} = require('../cli/services/toolkit/proxy-pool/cores/sing-box/outbound-fields');
const {
  normalizeDnsServer,
  normalizePhysicalInterfaceName
} = require('./zcode-network-underlay');

const DIRECT_OUTBOUND_TAG = 'aih-zcode-direct';
const UNDERLAY_DNS_TAG = 'aih-zcode-underlay-dns';

function stableHash(value, length = 16) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function requiredPort(value, code) {
  if (!isValidPort(value)) throw configError(code);
  return Number(value);
}

function requireUnprivilegedPort(value, code) {
  const port = requiredPort(value, code);
  if (port < 1024) throw configError(code);
  return port;
}

function buildTargetIdentity(target) {
  if (target.kind === 'direct') return 'direct';
  if (target.kind === 'proxy-url') return `url:${String(target.proxyUrl || '').trim()}`;
  if (target.kind === 'node') {
    const node = target.node || {};
    return `node:${String(node.id || [
      node.protocol,
      node.server,
      node.port,
      node.uuid || node.username || node.password || ''
    ].join('\u0000'))}`;
  }
  throw configError(`unsupported_zcode_target_${String(target.kind || 'empty')}`);
}

function buildTargetTag(target) {
  if (target.kind === 'direct') return DIRECT_OUTBOUND_TAG;
  return `aih-zcode-target-${stableHash(buildTargetIdentity(target))}`;
}

function compileProxyUrlOutbound(target, tag) {
  let parsed;
  const rawUrl = String(target.proxyUrl || '').trim();
  try {
    parsed = new URL(rawUrl.includes('://') ? rawUrl : `http://${rawUrl}`);
  } catch {
    throw configError('invalid_proxy_url');
  }
  const protocol = parsed.protocol.toLowerCase();
  const server = normalizeServerHost(parsed.hostname);
  if (!server) throw configError('invalid_proxy_url');
  if (protocol === 'http:' || protocol === 'https:') {
    const outbound = {
      type: 'http',
      tag,
      server,
      server_port: Number(parsed.port || (protocol === 'https:' ? 443 : 80))
    };
    if (parsed.username) outbound.username = decodeURIComponent(parsed.username);
    if (parsed.password) outbound.password = decodeURIComponent(parsed.password);
    if (protocol === 'https:') {
      outbound.tls = { enabled: true, server_name: server };
    }
    return outbound;
  }
  const versionByProtocol = {
    'socks:': '5',
    'socks4:': '4',
    'socks4a:': '4a',
    'socks5:': '5'
  };
  const version = versionByProtocol[protocol];
  if (!version) throw configError('invalid_proxy_url');
  const outbound = {
    type: 'socks',
    tag,
    server,
    server_port: Number(parsed.port || 1080),
    version
  };
  if (parsed.username) outbound.username = decodeURIComponent(parsed.username);
  if (parsed.password) outbound.password = decodeURIComponent(parsed.password);
  return outbound;
}

function compileNodeOutbound(target, tag) {
  const node = target.node && typeof target.node === 'object' ? target.node : {};
  const protocol = normalizeProtocol(node.protocol);
  const plugin = getProtocolPlugin(protocol);
  // 受支持协议来自代理池协议插件注册表；没有声明 compile['sing-box'] 的协议必须显式报错。
  if (!SUPPORTED_PROTOCOLS.has(protocol) || !plugin || typeof plugin.compile['sing-box'] !== 'function') {
    throw configError(`unsupported_proxy_protocol_${protocol || 'empty'}`);
  }
  const server = requiredString(normalizeServerHost(node.server), 'invalid_proxy_server');
  const serverPort = requiredPort(node.port, 'invalid_proxy_port');
  const base = { type: protocol, tag, server, server_port: serverPort };
  return plugin.compile['sing-box']({ ...node, protocol }, base);
}

function normalizeUnderlay(input) {
  if (!input) return null;
  const interfaceName = normalizePhysicalInterfaceName(input.interfaceName);
  const rawDnsServer = String(input.dnsServer || '').trim();
  const dnsServer = rawDnsServer ? normalizeDnsServer(rawDnsServer) : '';
  if (!interfaceName || (rawDnsServer && !dnsServer)) {
    throw configError('invalid_zcode_underlay');
  }
  return { interfaceName, dnsServer };
}

function isLoopbackServer(value) {
  const server = String(value || '').trim().toLowerCase();
  return server === 'localhost' || server === '::1' || server.startsWith('127.');
}

function applyOutboundUnderlay(outbound, input) {
  const underlay = normalizeUnderlay(input);
  if (!underlay || !outbound.server || isLoopbackServer(outbound.server)) return outbound;
  const compiled = { ...outbound, bind_interface: underlay.interfaceName };
  if (!net.isIP(outbound.server)) {
    if (!underlay.dnsServer) throw configError('invalid_zcode_underlay_dns');
    compiled.domain_resolver = UNDERLAY_DNS_TAG;
  }
  return compiled;
}

function compileZcodeSingBoxOutbound(target, options = {}) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw configError('invalid_zcode_sidecar_target');
  }
  const tag = buildTargetTag(target);
  if (target.kind === 'direct') {
    return { tag, identity: 'direct', outbound: { type: 'direct', tag } };
  }
  if (target.kind === 'proxy-url') {
    return {
      tag,
      identity: buildTargetIdentity(target),
      outbound: applyOutboundUnderlay(compileProxyUrlOutbound(target, tag), options.underlay)
    };
  }
  if (target.kind === 'node') {
    return {
      tag,
      identity: buildTargetIdentity(target),
      outbound: applyOutboundUnderlay(compileNodeOutbound(target, tag), options.underlay)
    };
  }
  throw configError(`unsupported_zcode_target_${String(target.kind || 'empty')}`);
}

function accountTags(accountRef) {
  const suffix = stableHash(accountRef, 12);
  return {
    inboundTag: `aih-zcode-in-${suffix}`,
    selectorTag: `aih-zcode-select-${suffix}`
  };
}

function addOutbound(outboundByTag, compiled) {
  const existing = outboundByTag.get(compiled.tag);
  if (existing && JSON.stringify(existing) !== JSON.stringify(compiled.outbound)) {
    throw configError('zcode_sidecar_outbound_tag_conflict');
  }
  if (!existing) outboundByTag.set(compiled.tag, compiled.outbound);
}

function compileZcodeSingBoxConfig(input = {}) {
  const controllerPort = requireUnprivilegedPort(
    input.controllerPort,
    'invalid_zcode_sidecar_controller_port'
  );
  const controllerSecret = requiredString(
    input.controllerSecret,
    'missing_zcode_sidecar_controller_secret'
  );
  const accountInputs = Array.isArray(input.accounts) ? input.accounts : [];
  if (!accountInputs.length) throw configError('missing_zcode_sidecar_accounts');

  const usedPorts = new Set([controllerPort]);
  const seenAccounts = new Set();
  const inbounds = [];
  const selectors = [];
  const routeRules = [];
  const accounts = {};
  const outboundByTag = new Map();
  const underlay = normalizeUnderlay(input.underlay);
  const compileTarget = (target) => compileZcodeSingBoxOutbound(target, { underlay });
  addOutbound(outboundByTag, compileZcodeSingBoxOutbound({ kind: 'direct' }));

  for (const accountInput of accountInputs) {
    const accountRef = requiredString(accountInput?.accountRef, 'invalid_zcode_sidecar_account');
    if (seenAccounts.has(accountRef)) throw configError('duplicate_zcode_sidecar_account');
    seenAccounts.add(accountRef);
    const listenPort = requireUnprivilegedPort(
      accountInput.listenPort,
      'invalid_zcode_sidecar_listen_port'
    );
    if (usedPorts.has(listenPort)) throw configError('duplicate_zcode_sidecar_port');
    usedPorts.add(listenPort);

    const candidateTargets = Array.isArray(accountInput.candidateTargets)
      ? accountInput.candidateTargets
      : [];
    if (!candidateTargets.length) throw configError('missing_zcode_sidecar_candidates');
    const compiledCandidates = candidateTargets.map(compileTarget);
    for (const compiled of compiledCandidates) addOutbound(outboundByTag, compiled);
    const selected = compileTarget(accountInput.selectedTarget);
    const selectedCandidate = compiledCandidates.find((candidate) => candidate.identity === selected.identity);
    if (!selectedCandidate) throw configError('selected_zcode_target_not_in_candidates');

    const { inboundTag, selectorTag } = accountTags(accountRef);
    const outboundTags = [...new Set(compiledCandidates.map((candidate) => candidate.tag))];
    inbounds.push({
      type: 'mixed',
      tag: inboundTag,
      listen: '127.0.0.1',
      listen_port: listenPort
    });
    selectors.push({
      type: 'selector',
      tag: selectorTag,
      outbounds: outboundTags,
      default: selectedCandidate.tag,
      interrupt_exist_connections: true
    });
    routeRules.push({
      inbound: [inboundTag],
      action: 'route',
      outbound: selectorTag
    });
    accounts[accountRef] = {
      accountRef,
      listenPort,
      inboundTag,
      selectorTag,
      outboundTags,
      candidateOutbounds: accountInput.candidateTargets
        .map((target, index) => ({
          nodeId: target?.kind === 'node' ? String(target.node?.id || '').trim() : '',
          outboundTag: compiledCandidates[index]?.tag || ''
        }))
        .filter((candidate) => candidate.nodeId && candidate.outboundTag),
      selectedOutboundTag: selectedCandidate.tag
    };
  }

  const logPath = String(input.logPath || '').trim();
  const outbounds = [...outboundByTag.values(), ...selectors];
  const usesUnderlayDns = outbounds.some((outbound) => outbound.domain_resolver === UNDERLAY_DNS_TAG);
  const config = {
    log: logPath
      ? { level: 'warn', timestamp: true, output: logPath }
      : { disabled: true },
    ...(usesUnderlayDns ? {
      dns: {
        servers: [{
          type: 'udp',
          tag: UNDERLAY_DNS_TAG,
          server: underlay.dnsServer,
          server_port: 53,
          bind_interface: underlay.interfaceName
        }]
      }
    } : {}),
    inbounds,
    outbounds,
    route: {
      rules: routeRules,
      final: DIRECT_OUTBOUND_TAG
    },
    experimental: {
      clash_api: {
        external_controller: `127.0.0.1:${controllerPort}`,
        secret: controllerSecret
      }
    }
  };
  const shapeConfig = {
    ...config,
    outbounds: config.outbounds.map((outbound) => (
      outbound.type === 'selector' ? { ...outbound, default: null } : outbound
    ))
  };
  return {
    config,
    json: `${JSON.stringify(config, null, 2)}\n`,
    configHash: stableHash(JSON.stringify(config), 64),
    shapeHash: stableHash(JSON.stringify(shapeConfig), 64),
    accounts
  };
}

module.exports = {
  DIRECT_OUTBOUND_TAG,
  UNDERLAY_DNS_TAG,
  compileZcodeSingBoxConfig,
  compileZcodeSingBoxOutbound
};
