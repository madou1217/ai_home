'use strict';

const { getProxyNodeStore } = require('./proxy-node-store');
const { parseProxyNode, encodeProxyNode, parseSubscriptionContent } = require('./protocol-parsers');
const { testTcpLatency, testNodesLatency } = require('./proxy-tester');
const { getDedicatedPortManager } = require('./dedicated-port-manager');
const { RoutingManager } = require('./routing-manager');
const { request } = require('undici');

/**
 * ProxyPoolService: Facade providing unified high-level APIs for Proxy Pool operations.
 */
class ProxyPoolService {
  constructor() {
    this.store = getProxyNodeStore();
    this.portManager = getDedicatedPortManager(this.store);
    this.routingManager = new RoutingManager(this.store);
  }

  // 1. Nodes
  listNodes(filter = {}) {
    const nodes = this.store.listNodes(filter);
    const routing = this.routingManager.getRoutingState();
    return {
      ok: true,
      total: nodes.length,
      activeOutboundNodeId: routing.activeOutboundNodeId,
      routingMode: routing.mode,
      nodes
    };
  }

  getNode(nodeId) {
    const node = this.store.getNode(nodeId);
    if (!node) return { ok: false, error: 'node_not_found' };
    return { ok: true, node, uri: encodeProxyNode(node) };
  }

  upsertNode(nodeInput) {
    const node = this.store.upsertNode(nodeInput);
    return { ok: true, node, uri: encodeProxyNode(node) };
  }

  deleteNode(nodeId) {
    this.portManager.stopDedicatedPortForNode(nodeId);
    this.store.deleteNode(nodeId);
    return { ok: true };
  }

  importNodes(textOrUrls, subscriptionId = null) {
    const parsedNodes = parseSubscriptionContent(textOrUrls);
    if (!parsedNodes.length) {
      return { ok: false, error: 'no_valid_proxy_nodes_found', count: 0 };
    }
    const inserted = this.store.bulkUpsertNodes(parsedNodes, subscriptionId);
    return {
      ok: true,
      count: inserted.length,
      nodes: inserted
    };
  }

  // 2. Subscriptions
  listSubscriptions() {
    const subs = this.store.listSubscriptions();
    return { ok: true, subscriptions: subs };
  }

  upsertSubscription(subInput) {
    const sub = this.store.upsertSubscription(subInput);
    return { ok: true, subscription: sub };
  }

  deleteSubscription(subId) {
    this.store.deleteSubscription(subId);
    return { ok: true };
  }

  async syncSubscription(subId) {
    const subs = this.store.listSubscriptions();
    const sub = subs.find((s) => s.id === subId);
    if (!sub) {
      return { ok: false, error: 'subscription_not_found' };
    }

    try {
      const response = await request(sub.url, {
        headers: {
          'User-Agent': 'ClashforWindows/0.20.39 mihomo/1.18.0 Sing-box/1.9.0'
        },
        headersTimeout: 10000,
        bodyTimeout: 15000
      });

      if (response.statusCode >= 400) {
        return { ok: false, error: `HTTP ${response.statusCode}` };
      }

      const bodyText = await response.body.text();
      const importResult = this.importNodes(bodyText, sub.id);

      if (importResult.ok) {
        this.store.upsertSubscription({
          ...sub,
          nodeCount: importResult.count,
          lastSyncedAt: Date.now()
        });
      }

      return importResult;
    } catch (e) {
      return { ok: false, error: `拉取订阅失败: ${e.message}` };
    }
  }

  // 3. Health & Latency Testing
  async pingNode(nodeId) {
    const node = this.store.getNode(nodeId);
    if (!node) return { ok: false, error: 'node_not_found' };

    const ping = await testTcpLatency(node.server, node.port);
    if (ping.ok) {
      this.store.updateNodeLatency(nodeId, ping.latencyMs);
    } else {
      this.store.updateNodeLatency(nodeId, -1);
    }

    return {
      ok: true,
      nodeId,
      reachable: ping.ok,
      latencyMs: ping.latencyMs,
      error: ping.error || null
    };
  }

  async pingAllNodes(filter = {}) {
    const nodes = this.store.listNodes(filter);
    const results = await testNodesLatency(nodes);

    for (const [nodeId, r] of Object.entries(results)) {
      this.store.updateNodeLatency(nodeId, r.ok ? r.latencyMs : -1);
    }

    return {
      ok: true,
      testedCount: Object.keys(results).length,
      results
    };
  }

  // 4. Dedicated Inbound Ports
  getDedicatedPorts() {
    const config = this.store.getDedicatedPortsConfig();
    const active = this.portManager.getActiveServers();
    return {
      ok: true,
      config,
      active
    };
  }

  async toggleDedicatedPort(nodeId, enabled, requestedPort = null) {
    if (enabled) {
      return await this.portManager.startDedicatedPortForNode(nodeId, requestedPort);
    } else {
      return await this.portManager.stopDedicatedPortForNode(nodeId);
    }
  }

  updateDedicatedPortsConfig(config) {
    const updated = this.store.setDedicatedPortsConfig(config);
    return { ok: true, config: updated };
  }

  // 5. Routing
  getRouting() {
    return {
      ok: true,
      routing: this.routingManager.getRoutingState()
    };
  }

  setRoutingMode(mode, activeOutboundNodeId = null) {
    const updated = this.routingManager.setRoutingMode(mode, activeOutboundNodeId);
    return { ok: true, routing: updated };
  }

  updateRoutingRules(rules) {
    const updated = this.routingManager.updateRules(rules);
    return { ok: true, routing: updated };
  }
}

let defaultService = null;
function getProxyPoolService() {
  if (!defaultService) {
    defaultService = new ProxyPoolService();
  }
  return defaultService;
}

module.exports = {
  ProxyPoolService,
  getProxyPoolService
};
