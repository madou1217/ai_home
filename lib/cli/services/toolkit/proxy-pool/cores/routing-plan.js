'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { isValidPort } = require('../proxy-protocol-contract');

/**
 * 内核中立的配置规划：节点稳定命名、路由规则与专用端口监听。
 * 各内核编译器只负责把规划结果翻译成自己的配置语法（mihomo YAML / sing-box JSON），
 * 规则语义与 routing_* / dedicated_listener_* 告警在两个内核间保持一致。
 */
const DIRECT = Object.freeze({ kind: 'direct' });
const REJECT = Object.freeze({ kind: 'reject' });

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

/**
 * 逐个编译节点：重复 id 跳过、名称冲突加序号，编译失败记入 skippedNodes。
 * compileNode(node, name) 返回该内核的出站对象，抛错即跳过。
 */
function planNodes(nodes, compileNode) {
  const nodeNameById = {};
  const outbounds = [];
  const skippedNodes = [];
  const usedNames = new Set();
  const seenIds = new Set();
  for (const node of Array.isArray(nodes) ? nodes : []) {
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
      outbounds.push(compileNode(node || {}, proxyName));
      usedNames.add(proxyName);
      if (nodeId) nodeNameById[nodeId] = proxyName;
    } catch (error) {
      skippedNodes.push({ nodeId: nodeId || null, name: node?.name || null, reason: error.message });
    }
  }
  return { nodeNameById, outbounds, skippedNodes };
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
  return { cidr: `${address}/${prefix}`, version };
}

function resolveOutbound(nodeId, nodeNameById) {
  return nodeId && nodeNameById[nodeId] ? { kind: 'proxy', name: nodeNameById[nodeId] } : null;
}

/**
 * 路由规划：返回 { mode, final, rules[{ type:'domain'|'ip', value, ipVersion?, target }] }，
 * target 为 { kind:'proxy', name } / DIRECT / REJECT；final 同理（找不到活动出站时为 DIRECT）。
 */
function planRouting(routing, nodeNameById, warnings) {
  if (routing?.mode !== undefined && !['global', 'rule', 'direct'].includes(routing.mode)) {
    throw new Error('invalid_routing_mode');
  }
  if (routing?.rules !== undefined && !Array.isArray(routing.rules)) throw new Error('invalid_routing_rules');
  const mode = routing?.mode || 'rule';
  const active = resolveOutbound(routing?.activeOutboundNodeId, nodeNameById);
  if (mode === 'direct') return { mode, final: DIRECT, rules: [] };
  if (mode === 'global') {
    if (!active) warnings.push('routing_active_outbound_unavailable_using_direct');
    return { mode, final: active || DIRECT, rules: [] };
  }

  const rules = [];
  for (const rule of Array.isArray(routing?.rules) ? routing.rules : []) {
    const ruleId = String(rule.id || 'unnamed');
    if (!['proxy', 'direct', 'reject', undefined].includes(rule.outbound)) {
      warnings.push(`routing_rule_${ruleId}_invalid_outbound`);
      continue;
    }
    const target = rule.outbound === 'direct'
      ? DIRECT
      : (rule.outbound === 'reject'
        ? REJECT
        : resolveOutbound(rule.nodeId || routing.activeOutboundNodeId, nodeNameById));
    if (!target) {
      warnings.push(`routing_rule_${ruleId}_outbound_unavailable`);
      continue;
    }
    for (const rawDomain of Array.isArray(rule.domains) ? rule.domains : []) {
      const domain = normalizeDomain(rawDomain);
      if (domain) rules.push({ type: 'domain', value: domain, target });
      else warnings.push(`routing_rule_${ruleId}_invalid_domain`);
    }
    for (const rawIp of Array.isArray(rule.ips) ? rule.ips : []) {
      const ipRule = normalizeIpRule(rawIp);
      if (ipRule) rules.push({ type: 'ip', value: ipRule.cidr, ipVersion: ipRule.version, target });
      else warnings.push(`routing_rule_${ruleId}_invalid_ip`);
    }
  }
  if (!active) warnings.push('routing_active_outbound_unavailable_using_direct');
  return { mode, final: active || DIRECT, rules };
}

/** 专用端口规划：每个映射一个只绑 127.0.0.1 的 mixed 监听，直连到对应节点出站。 */
function planDedicatedListeners(dedicatedPorts, nodeNameById, warnings) {
  const mappings = dedicatedPorts?.enabled === false ? {} : (dedicatedPorts?.mappings || {});
  const listeners = [];
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
    listeners.push({ nodeId, name: `aih-listener-${stableHash(nodeId)}`, port: Number(rawPort), proxyName });
  }
  return listeners;
}

/** 端口合法性与冲突检查：混合端口、控制器端口与各专用监听端口两两不同。 */
function assertListenerPorts({ mixedPort, controllerPort, listeners, errorPrefix }) {
  if (!isValidPort(mixedPort)) throw new Error(`invalid_${errorPrefix}_mixed_port`);
  if (!isValidPort(controllerPort)) throw new Error(`invalid_${errorPrefix}_controller_port`);
  if (mixedPort === controllerPort || listeners.some((listener) => listener.port === mixedPort || listener.port === controllerPort)) {
    throw new Error(`${errorPrefix}_listener_port_conflict`);
  }
  if (new Set(listeners.map((listener) => listener.port)).size !== listeners.length) {
    throw new Error(`${errorPrefix}_listener_port_conflict`);
  }
}

module.exports = {
  DIRECT,
  REJECT,
  assertListenerPorts,
  buildStableProxyName,
  normalizeDomain,
  normalizeIpRule,
  planDedicatedListeners,
  planNodes,
  planRouting,
  stableHash
};
