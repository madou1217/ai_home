'use strict';

const { normalizeServerHost } = require('../../protocol-parsers/base-parser');
const {
  isValidPort,
  normalizeProtocol,
  SUPPORTED_PROTOCOLS
} = require('../../proxy-protocol-contract');
const { getProtocolPlugin } = require('../../protocols');
const { requiredString } = require('./proxy-fields');
const {
  assertListenerPorts,
  buildStableProxyName,
  planDedicatedListeners,
  planNodes,
  planRouting
} = require('../routing-plan');

const DEFAULT_MIXED_PORT = 10800;
const DEFAULT_CONTROLLER_PORT = 19090;

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

function compileProxy(node, name) {
  const protocol = normalizeProtocol(node.protocol);
  const plugin = getProtocolPlugin(protocol);
  if (!SUPPORTED_PROTOCOLS.has(protocol) || !plugin || typeof plugin.compile?.mihomo !== 'function') {
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
  // 协议相关字段由协议插件负责（protocols/<id>.js 的 compile.mihomo）。
  return plugin.compile.mihomo({ ...node, protocol }, proxy);
}

function formatTarget(target) {
  if (target.kind === 'direct') return 'DIRECT';
  if (target.kind === 'reject') return 'REJECT';
  return target.name;
}

// 路由规划由 ../routing-plan.js 统一产生，这里只翻译为 mihomo 规则语法。
function compileRules(routing, nodeNameById, warnings) {
  const plan = planRouting(routing, nodeNameById, warnings);
  if (plan.mode === 'direct') return ['MATCH,DIRECT'];
  const rules = plan.rules.map((rule) => (rule.type === 'domain'
    ? `DOMAIN-SUFFIX,${rule.value},${formatTarget(rule.target)}`
    : `${rule.ipVersion === 4 ? 'IP-CIDR' : 'IP-CIDR6'},${rule.value},${formatTarget(rule.target)},no-resolve`));
  rules.push(`MATCH,${formatTarget(plan.final)}`);
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
  const warnings = [];
  const { nodeNameById, outbounds: proxies, skippedNodes } = planNodes(input.nodes, compileProxy);
  const planned = planDedicatedListeners(input.dedicatedPorts, nodeNameById, warnings);
  const listeners = planned.map((listener) => ({
    name: listener.name,
    type: 'mixed',
    port: listener.port,
    listen: '127.0.0.1',
    proxy: listener.proxyName
  }));
  const activeListeners = planned.map((listener) => ({
    nodeId: listener.nodeId,
    name: listener.name,
    port: listener.port,
    listening: false
  }));

  const mixedPort = input.mixedPort === undefined ? DEFAULT_MIXED_PORT : Number(input.mixedPort);
  const controllerPort = input.controllerPort === undefined
    ? DEFAULT_CONTROLLER_PORT
    : Number(input.controllerPort);
  assertListenerPorts({ mixedPort, controllerPort, listeners, errorPrefix: 'mihomo' });

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
  compileMihomoProxy: compileProxy,
  emitYaml,
  isValidPort
};
