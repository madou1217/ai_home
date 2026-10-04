'use strict';

const {
  assertListenerPorts,
  planDedicatedListeners,
  planNodes,
  planRouting
} = require('../routing-plan');
const { compileSingBoxNodeOutbound } = require('./node-outbound');

const DEFAULT_MIXED_PORT = 10800;
// 与 mihomo（19090）、ZCode sing-box 出口（独立状态文件分配）错开，避免同机冲突。
const DEFAULT_CONTROLLER_PORT = 19091;
const MIXED_INBOUND_TAG = 'aih-mixed';
const TUN_INBOUND_TAG = 'aih-tun';
const DIRECT_OUTBOUND_TAG = 'direct';

function routeTarget(target) {
  if (target.kind === 'reject') return { action: 'reject' };
  return { action: 'route', outbound: target.kind === 'direct' ? DIRECT_OUTBOUND_TAG : target.name };
}

function finalTag(target) {
  return target.kind === 'proxy' ? target.name : DIRECT_OUTBOUND_TAG;
}

function compileTunInbound(tun = {}) {
  if (tun?.enabled !== true) return null;
  const stackValue = String(tun.stack || '').toLowerCase();
  return {
    type: 'tun',
    tag: TUN_INBOUND_TAG,
    address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
    auto_route: tun.autoRoute !== false,
    strict_route: tun.strictRoute === true,
    stack: ['system', 'gvisor', 'mixed'].includes(stackValue) ? stackValue : 'mixed'
  };
}

/**
 * 代理池 → sing-box JSON 配置。输入/输出契约与 compileMihomoConfig 一致：
 * { content, config, nodeNameById, exportedNodeCount, skippedNodes, warnings, activeListeners }。
 * 语法基于 sing-box ≥ 1.11 的规则动作（action: route / reject / sniff / hijack-dns）。
 */
function compileSingBoxConfig(input = {}, options = {}) {
  const warnings = [];
  const { nodeNameById, outbounds, skippedNodes } = planNodes(input.nodes, compileSingBoxNodeOutbound);
  const planned = planDedicatedListeners(input.dedicatedPorts, nodeNameById, warnings);
  const mixedPort = input.mixedPort === undefined ? DEFAULT_MIXED_PORT : Number(input.mixedPort);
  const controllerPort = input.controllerPort === undefined ? DEFAULT_CONTROLLER_PORT : Number(input.controllerPort);
  assertListenerPorts({ mixedPort, controllerPort, listeners: planned, errorPrefix: 'sing_box' });
  const routing = planRouting(input.routing || {}, nodeNameById, warnings);

  const tunInbound = compileTunInbound(input.tun);
  const inbounds = [
    { type: 'mixed', tag: MIXED_INBOUND_TAG, listen: '127.0.0.1', listen_port: mixedPort },
    ...planned.map((listener) => ({ type: 'mixed', tag: listener.name, listen: '127.0.0.1', listen_port: listener.port })),
    ...(tunInbound ? [tunInbound] : [])
  ];

  const rules = [];
  if (tunInbound) {
    rules.push({ inbound: [TUN_INBOUND_TAG], action: 'sniff' });
    rules.push({ protocol: 'dns', action: 'hijack-dns' });
  }
  // 专用端口始终直连到其节点，优先于分流规则。
  for (const listener of planned) {
    rules.push({ inbound: [listener.name], action: 'route', outbound: listener.proxyName });
  }
  for (const rule of routing.rules) {
    const match = rule.type === 'domain' ? { domain_suffix: [rule.value] } : { ip_cidr: [rule.value] };
    rules.push({ ...match, ...routeTarget(rule.target) });
  }

  const includeController = options.includeController !== false;
  const config = {
    log: { level: options.logLevel || 'warn', timestamp: true },
    ...(tunInbound ? { dns: { servers: [{ type: 'local', tag: 'aih-local-dns' }] } } : {}),
    inbounds,
    outbounds: [{ type: 'direct', tag: DIRECT_OUTBOUND_TAG }, ...outbounds],
    route: {
      rules,
      final: finalTag(routing.final),
      ...(tunInbound ? { auto_detect_interface: input.tun.autoDetectInterface !== false } : {})
    },
    ...(includeController ? {
      experimental: {
        clash_api: {
          external_controller: `127.0.0.1:${controllerPort}`,
          secret: String(input.controllerSecret || '')
        }
      }
    } : {})
  };

  return {
    content: `${JSON.stringify(config, null, 2)}\n`,
    config,
    mixedPort,
    nodeNameById,
    exportedNodeCount: outbounds.length,
    skippedNodes,
    warnings,
    activeListeners: planned.map((listener) => ({
      nodeId: listener.nodeId,
      name: listener.name,
      port: listener.port,
      listening: false
    }))
  };
}

module.exports = {
  DEFAULT_CONTROLLER_PORT,
  DEFAULT_MIXED_PORT,
  MIXED_INBOUND_TAG,
  compileSingBoxConfig
};
