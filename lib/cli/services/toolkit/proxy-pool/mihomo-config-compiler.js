'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { normalizeServerHost } = require('./protocol-parsers/base-parser');

const DEFAULT_MIXED_PORT = 10800;
const DEFAULT_CONTROLLER_PORT = 19090;
const SUPPORTED_PROTOCOLS = new Set([
  'shadowsocks',
  'vmess',
  'vless',
  'trojan',
  'hysteria2',
  'socks5',
  'http',
  'https'
]);
const SUPPORTED_TRANSPORTS = new Set(['tcp', 'ws', 'grpc']);

function isValidPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
}

function buildStableProxyName(node = {}) {
  const readableSource = node.id ? (node.protocol || 'proxy') : (node.name || node.protocol || 'proxy');
  const readable = String(readableSource)
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28) || 'proxy';
  const identity = node.id || [
    node.protocol,
    node.server,
    node.port,
    node.uuid || node.username || node.password || '',
    node.name || ''
  ].join('\u0000');
  return `aih-${readable}-${stableHash(identity)}`;
}

function yamlScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non_finite_yaml_number');
    return String(value);
  }
  return JSON.stringify(String(value));
}

function yamlKey(key) {
  const text = String(key);
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : JSON.stringify(text);
}

function emitYaml(value, indent = 0) {
  const padding = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${padding}[]`;
    return value.map((item) => {
      if (item !== null && typeof item === 'object') {
        const nested = emitYaml(item, indent + 2);
        const nestedLines = nested.split('\n');
        return `${padding}- ${nestedLines[0].trimStart()}${nestedLines.length > 1 ? `\n${nestedLines.slice(1).join('\n')}` : ''}`;
      }
      return `${padding}- ${yamlScalar(item)}`;
    }).join('\n');
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return `${padding}{}`;
    return entries.map(([key, item]) => {
      if (item !== null && typeof item === 'object') {
        if ((Array.isArray(item) && item.length === 0) || (!Array.isArray(item) && Object.keys(item).length === 0)) {
          return `${padding}${yamlKey(key)}: ${Array.isArray(item) ? '[]' : '{}'}`;
        }
        return `${padding}${yamlKey(key)}:\n${emitYaml(item, indent + 2)}`;
      }
      return `${padding}${yamlKey(key)}: ${yamlScalar(item)}`;
    }).join('\n');
  }
  return `${padding}${yamlScalar(value)}`;
}

function normalizeProtocol(protocol) {
  const value = String(protocol || '').toLowerCase();
  return value === 'ss' ? 'shadowsocks' : (value === 'hy2' ? 'hysteria2' : value);
}

function requiredString(node, field) {
  if (typeof node[field] !== 'string' || node[field].length === 0) {
    throw new Error(`missing_required_proxy_field_${field}`);
  }
  return node[field];
}

function normalizePluginOptions(value) {
  if (!value) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const normalized = {};
    for (const [key, item] of Object.entries(value)) {
      if (!/^[A-Za-z0-9_-]+$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new Error('unsupported_shadowsocks_plugin_option');
      }
      if (!['string', 'number', 'boolean'].includes(typeof item)) {
        throw new Error(`unsupported_shadowsocks_plugin_option_${key}`);
      }
      if (typeof item === 'number' && !Number.isFinite(item)) {
        throw new Error(`unsupported_shadowsocks_plugin_option_${key}`);
      }
      normalized[key] = item;
    }
    return normalized;
  }
  if (typeof value !== 'string') throw new Error('unsupported_shadowsocks_plugin_options');
  const normalized = {};
  for (const token of value.split(';').map((item) => item.trim()).filter(Boolean)) {
    const separator = token.indexOf('=');
    const key = separator === -1 ? token : token.slice(0, separator);
    if (!/^[A-Za-z0-9_-]+$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new Error('unsupported_shadowsocks_plugin_option');
    }
    if (separator === -1) normalized[key] = true;
    else normalized[key] = token.slice(separator + 1);
  }
  return normalized;
}

function transportOptions(node, proxy) {
  const network = String(node.network || 'tcp').toLowerCase();
  if (!SUPPORTED_TRANSPORTS.has(network)) {
    throw new Error(`unsupported_proxy_transport_${network || 'empty'}`);
  }
  proxy.network = network;
  if (network === 'ws') {
    proxy['ws-opts'] = {
      path: node.path || '/',
      headers: node.host ? { Host: node.host } : undefined
    };
  }
  if (network === 'grpc') {
    proxy['grpc-opts'] = {
      'grpc-service-name': node.serviceName || ''
    };
  }
}

function tlsOptions(node, proxy) {
  if (node.tls) proxy.tls = true;
  if (node.sni) proxy.servername = node.sni;
  if (node.alpn) {
    proxy.alpn = Array.isArray(node.alpn)
      ? node.alpn.map(String)
      : String(node.alpn).split(',').map((value) => value.trim()).filter(Boolean);
  }
  if (node.allowInsecure || node.insecure) proxy['skip-cert-verify'] = true;
}

function compileProxy(node, name) {
  const protocol = normalizeProtocol(node.protocol);
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw new Error(`unsupported_proxy_protocol_${protocol || 'empty'}`);
  }
  const server = normalizeServerHost(requiredString(node, 'server'));
  if (!server) throw new Error('missing_required_proxy_field_server');
  if (!isValidPort(node.port)) throw new Error('invalid_proxy_port');

  const proxy = {
    name,
    server,
    port: Number(node.port)
  };

  if (protocol === 'shadowsocks') {
    proxy.type = 'ss';
    proxy.cipher = requiredString(node, 'cipher');
    proxy.password = requiredString(node, 'password');
    if (node.plugin) {
      proxy.plugin = String(node.plugin);
      if (node.pluginOpts) proxy['plugin-opts'] = normalizePluginOptions(node.pluginOpts);
    }
    return proxy;
  }

  if (protocol === 'vmess') {
    if (node.type && node.type !== 'none') throw new Error(`unsupported_proxy_field_type_${node.type}`);
    proxy.type = 'vmess';
    proxy.uuid = requiredString(node, 'uuid');
    proxy.alterId = Number.isInteger(Number(node.alterId)) ? Number(node.alterId) : 0;
    proxy.cipher = node.cipher || 'auto';
    transportOptions(node, proxy);
    tlsOptions(node, proxy);
    return proxy;
  }

  if (protocol === 'vless') {
    proxy.type = 'vless';
    proxy.uuid = requiredString(node, 'uuid');
    transportOptions(node, proxy);
    tlsOptions(node, proxy);
    if (node.flow) proxy.flow = String(node.flow);
    const security = String(node.security || (node.tls ? 'tls' : 'none')).toLowerCase();
    if (!['none', 'tls', 'reality'].includes(security)) {
      throw new Error(`unsupported_proxy_security_${security}`);
    }
    if (security === 'tls') proxy.tls = true;
    if (security === 'reality' || node.publicKey) {
      if (!node.publicKey) throw new Error('missing_required_proxy_field_publicKey');
      proxy.tls = true;
      proxy['reality-opts'] = {
        'public-key': String(node.publicKey),
        'short-id': String(node.shortId || '')
      };
      proxy['client-fingerprint'] = String(node.fingerprint || 'chrome');
    } else if (node.fingerprint) {
      proxy['client-fingerprint'] = String(node.fingerprint);
    }
    return proxy;
  }

  if (protocol === 'trojan') {
    proxy.type = 'trojan';
    proxy.password = requiredString(node, 'password');
    transportOptions(node, proxy);
    tlsOptions({ ...node, tls: true }, proxy);
    return proxy;
  }

  if (protocol === 'hysteria2') {
    proxy.type = 'hysteria2';
    proxy.password = requiredString(node, 'password');
    if (node.sni) proxy.sni = String(node.sni);
    proxy['skip-cert-verify'] = Boolean(node.insecure || node.allowInsecure);
    if (node.obfs) {
      proxy.obfs = String(node.obfs);
      proxy['obfs-password'] = requiredString(node, 'obfsPassword');
    }
    if (node.upMbps !== undefined) {
      const value = Number(node.upMbps);
      if (!Number.isFinite(value) || value <= 0) throw new Error('invalid_proxy_field_upMbps');
      proxy.up = `${value} Mbps`;
    }
    if (node.downMbps !== undefined) {
      const value = Number(node.downMbps);
      if (!Number.isFinite(value) || value <= 0) throw new Error('invalid_proxy_field_downMbps');
      proxy.down = `${value} Mbps`;
    }
    return proxy;
  }

  if (protocol === 'socks5') {
    proxy.type = 'socks5';
  } else {
    proxy.type = 'http';
    if (protocol === 'https') proxy.tls = true;
  }
  if (node.username) proxy.username = String(node.username);
  if (node.password) proxy.password = String(node.password);
  return proxy;
}

function normalizeDomain(value) {
  const domain = String(value || '').trim().toLowerCase().replace(/^\./, '');
  if (!domain || domain.length > 253 || domain.includes(',') || !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(domain)) {
    return null;
  }
  return domain;
}

function normalizeIpRule(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.includes(',')) return null;
  const [address, prefixText] = raw.split('/');
  const version = net.isIP(address);
  if (!version) return null;
  const maxPrefix = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return null;
  return { cidr: `${address}/${prefix}`, type: version === 4 ? 'IP-CIDR' : 'IP-CIDR6' };
}

function resolveOutboundName(nodeId, nodeNameById) {
  return nodeId && nodeNameById[nodeId] ? nodeNameById[nodeId] : null;
}

function compileRules(routing, nodeNameById, warnings) {
  if (routing?.mode !== undefined && !['global', 'rule', 'direct'].includes(routing.mode)) {
    throw new Error('invalid_routing_mode');
  }
  if (routing?.rules !== undefined && !Array.isArray(routing.rules)) throw new Error('invalid_routing_rules');
  const mode = routing?.mode || 'rule';
  const activeName = resolveOutboundName(routing?.activeOutboundNodeId, nodeNameById);
  if (mode === 'direct') return ['MATCH,DIRECT'];
  if (mode === 'global') {
    if (!activeName) warnings.push('routing_active_outbound_unavailable_using_direct');
    return [`MATCH,${activeName || 'DIRECT'}`];
  }

  const rules = [];
  for (const rule of Array.isArray(routing?.rules) ? routing.rules : []) {
    if (!['proxy', 'direct', 'reject', undefined].includes(rule.outbound)) {
      warnings.push(`routing_rule_${String(rule.id || 'unnamed')}_invalid_outbound`);
      continue;
    }
    const outbound = rule.outbound === 'direct'
      ? 'DIRECT'
      : (rule.outbound === 'reject'
        ? 'REJECT'
        : resolveOutboundName(rule.nodeId || routing.activeOutboundNodeId, nodeNameById));
    if (!outbound) {
      warnings.push(`routing_rule_${String(rule.id || 'unnamed')}_outbound_unavailable`);
      continue;
    }
    for (const rawDomain of Array.isArray(rule.domains) ? rule.domains : []) {
      const domain = normalizeDomain(rawDomain);
      if (domain) rules.push(`DOMAIN-SUFFIX,${domain},${outbound}`);
      else warnings.push(`routing_rule_${String(rule.id || 'unnamed')}_invalid_domain`);
    }
    for (const rawIp of Array.isArray(rule.ips) ? rule.ips : []) {
      const ipRule = normalizeIpRule(rawIp);
      if (ipRule) rules.push(`${ipRule.type},${ipRule.cidr},${outbound},no-resolve`);
      else warnings.push(`routing_rule_${String(rule.id || 'unnamed')}_invalid_ip`);
    }
  }
  if (!activeName) warnings.push('routing_active_outbound_unavailable_using_direct');
  rules.push(`MATCH,${activeName || 'DIRECT'}`);
  return rules;
}

function compileTunConfig(tun = {}) {
  if (tun?.enabled !== true) return undefined;
  const stackValue = String(tun.stack || '').toLowerCase();
  const stack = ['system', 'gvisor', 'mixed'].includes(stackValue) ? stackValue : 'mixed';
  const dnsHijack = Array.isArray(tun.dnsHijack) && tun.dnsHijack.length
    ? tun.dnsHijack.map(String).filter(Boolean)
    : ['any:53'];
  return {
    enable: true,
    stack,
    'auto-route': tun.autoRoute !== false,
    'auto-detect-interface': tun.autoDetectInterface !== false,
    'strict-route': tun.strictRoute === true,
    'dns-hijack': dnsHijack
  };
}

function compileMihomoConfig(input = {}, options = {}) {
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const nodeNameById = {};
  const proxies = [];
  const skippedNodes = [];
  const warnings = [];
  const usedNames = new Set();
  const seenIds = new Set();

  for (const node of nodes) {
    const nodeId = String(node?.id || '');
    if (nodeId && seenIds.has(nodeId)) {
      skippedNodes.push({ nodeId, name: node?.name || null, reason: 'duplicate_proxy_node_id' });
      continue;
    }
    if (nodeId) seenIds.add(nodeId);
    let proxyName = buildStableProxyName(node);
    let collision = 2;
    while (usedNames.has(proxyName)) {
      proxyName = `${buildStableProxyName(node)}-${collision++}`;
    }
    try {
      const proxy = compileProxy(node || {}, proxyName);
      proxies.push(proxy);
      usedNames.add(proxyName);
      if (nodeId) nodeNameById[nodeId] = proxyName;
    } catch (error) {
      skippedNodes.push({
        nodeId: nodeId || null,
        name: node?.name || null,
        reason: error.message
      });
    }
  }

  const mappings = input.dedicatedPorts?.enabled === false
    ? {}
    : (input.dedicatedPorts?.mappings || {});
  const listeners = [];
  const activeListeners = [];
  for (const [nodeId, rawPort] of Object.entries(mappings)) {
    const proxyName = nodeNameById[nodeId];
    if (!proxyName) {
      warnings.push(`dedicated_listener_${nodeId}_outbound_unavailable`);
      continue;
    }
    if (!isValidPort(rawPort)) {
      warnings.push(`dedicated_listener_${nodeId}_invalid_port`);
      continue;
    }
    const listener = {
      name: `aih-listener-${stableHash(nodeId)}`,
      type: 'mixed',
      port: Number(rawPort),
      listen: '127.0.0.1',
      proxy: proxyName
    };
    listeners.push(listener);
    activeListeners.push({ nodeId, name: listener.name, port: listener.port, listening: false });
  }

  const mixedPort = input.mixedPort === undefined ? DEFAULT_MIXED_PORT : Number(input.mixedPort);
  const controllerPort = input.controllerPort === undefined
    ? DEFAULT_CONTROLLER_PORT
    : Number(input.controllerPort);
  if (!isValidPort(mixedPort)) throw new Error('invalid_mihomo_mixed_port');
  if (!isValidPort(controllerPort)) throw new Error('invalid_mihomo_controller_port');
  if (mixedPort === controllerPort || listeners.some((listener) => listener.port === mixedPort || listener.port === controllerPort)) {
    throw new Error('mihomo_listener_port_conflict');
  }
  if (new Set(listeners.map((listener) => listener.port)).size !== listeners.length) {
    throw new Error('mihomo_listener_port_conflict');
  }

  const includeController = options.includeController !== false;
  const config = {
    'mixed-port': mixedPort,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: 'rule',
    'log-level': options.logLevel || 'warning',
    ipv6: false,
    'external-controller': includeController ? `127.0.0.1:${controllerPort}` : undefined,
    secret: includeController ? String(input.controllerSecret || '') : undefined,
    tun: compileTunConfig(input.tun),
    proxies,
    listeners,
    rules: compileRules(input.routing || {}, nodeNameById, warnings)
  };

  return {
    content: `${emitYaml(config)}\n`,
    config,
    nodeNameById,
    exportedNodeCount: proxies.length,
    skippedNodes,
    warnings,
    activeListeners
  };
}

module.exports = {
  DEFAULT_MIXED_PORT,
  DEFAULT_CONTROLLER_PORT,
  SUPPORTED_PROTOCOLS,
  buildStableProxyName,
  compileMihomoConfig,
  emitYaml,
  isValidPort
};
