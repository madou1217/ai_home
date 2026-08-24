'use strict';

const {
  getProxyNodeStore,
  validateProxyNodeInput
} = require('../cli/services/toolkit/proxy-pool/proxy-node-store');
const {
  encodeProxyNode,
  parseClashYamlProxiesDetailed,
  parseSubscriptionContent
} = require('../cli/services/toolkit/proxy-pool/protocol-parsers');
const {
  SubscriptionFetcher
} = require('../cli/services/toolkit/proxy-pool/subscription-fetcher');
const { compileZcodeSingBoxOutbound } = require('../server/zcode-sing-box-config');

function isSingleHttpUrl(value) {
  const text = String(value || '').trim();
  if (!text || /[\r\n]/u.test(text)) return false;
  try {
    return ['http:', 'https:'].includes(new URL(text).protocol);
  } catch {
    return false;
  }
}

function unsupportedSchemes(content) {
  const supported = new Set([
    'ss', 'vmess', 'vless', 'trojan', 'hy2', 'hysteria2', 'hysteria',
    'socks', 'socks5', 'http', 'https'
  ]);
  const schemes = [];
  for (const line of String(content || '').split(/[\r\n]+/u)) {
    const match = line.trim().match(/^([a-z][a-z0-9+.-]*):\/\//iu);
    if (match && !supported.has(match[1].toLowerCase())) schemes.push(match[1].toLowerCase());
  }
  return [...new Set(schemes)];
}

class AccountEgressCatalogService {
  constructor(options = {}) {
    this.store = options.store || getProxyNodeStore(options.storeOptions);
    this.subscriptionFetcher = options.subscriptionFetcher
      || new SubscriptionFetcher(options.subscriptionOptions);
    this.mutationTail = Promise.resolve();
  }

  _enqueueMutation(operation) {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  _validateNode(node) {
    validateProxyNodeInput(node);
    compileZcodeSingBoxOutbound({ kind: 'node', node });
  }

  _listCatalogGroups() {
    return this.store.listGroups().filter((group) => group.id !== 'dedicated');
  }

  _toCatalogNode(node) {
    const catalogNode = { ...node };
    delete catalogNode.dedicatedPort;
    return catalogNode;
  }

  _parseImportContent(content, subscriptionId = null) {
    const source = String(content || '');
    const yaml = /^\s*proxies\s*:/mu.test(source)
      ? parseClashYamlProxiesDetailed(source)
      : null;
    const parsedNodes = yaml ? yaml.nodes : parseSubscriptionContent(source);
    const nodes = [];
    const skippedNodes = (yaml?.skippedNodes || []).concat(
      unsupportedSchemes(source).map((protocol) => ({
        nodeId: null,
        name: null,
        reason: `unsupported_proxy_protocol_${protocol}`
      }))
    );
    for (const node of parsedNodes) {
      try {
        this._validateNode(node);
        nodes.push({
          ...node,
          subscriptionId: subscriptionId || node.subscriptionId || null
        });
      } catch (error) {
        skippedNodes.push({
          nodeId: node.id || null,
          name: node.name || null,
          reason: String(error?.code || error?.message || 'invalid_proxy_node')
        });
      }
    }
    return { nodes, skippedNodes, warnings: yaml?.warnings || [] };
  }

  listNodes(filter = {}) {
    const nodes = this.store.listNodes(filter).map((node) => this._toCatalogNode(node));
    return {
      ok: true,
      total: nodes.length,
      groups: this._listCatalogGroups(),
      nodes
    };
  }

  listGroups() {
    return { ok: true, groups: this._listCatalogGroups() };
  }

  upsertGroup(groupInput) {
    return this._enqueueMutation(() => ({
      ok: true,
      applied: true,
      group: this.store.upsertGroup(groupInput)
    }));
  }

  updateGroupPolicy(groupId, policyInput) {
    return this._enqueueMutation(() => ({
      ok: true,
      applied: true,
      group: this.store.updateGroupPolicy(groupId, policyInput)
    }));
  }

  deleteGroup(groupId) {
    return this._enqueueMutation(() => {
      const deleted = this.store.deleteGroup(groupId);
      return deleted
        ? { ok: true, applied: true }
        : { ok: false, applied: false, error: 'proxy_group_not_found' };
    });
  }

  upsertNode(nodeInput) {
    return this._enqueueMutation(() => {
      this._validateNode(nodeInput);
      const node = this.store.upsertNode(nodeInput);
      return {
        ok: true,
        applied: true,
        node: this._toCatalogNode(node),
        uri: encodeProxyNode(node)
      };
    });
  }

  deleteNode(nodeId) {
    return this._enqueueMutation(() => {
      const snapshot = this.store.deleteNodeWithSnapshot(nodeId);
      return snapshot
        ? { ok: true, applied: true }
        : { ok: false, applied: false, error: 'node_not_found' };
    });
  }

  importNodes(content, subscriptionId = null) {
    return this._enqueueMutation(() => {
      if (isSingleHttpUrl(content)) {
        return { ok: false, error: 'subscription_url_requires_subscription_flow', count: 0 };
      }
      const parsed = this._parseImportContent(content, subscriptionId);
      if (!parsed.nodes.length) {
        return {
          ok: false,
          applied: false,
          error: 'no_valid_proxy_nodes_found',
          count: 0,
          skippedNodes: parsed.skippedNodes,
          warnings: parsed.warnings
        };
      }
      const nodes = this.store.bulkUpsertNodes(parsed.nodes, subscriptionId);
      return {
        ok: true,
        applied: true,
        count: nodes.length,
        nodes: nodes.map((node) => this._toCatalogNode(node)),
        skippedNodes: parsed.skippedNodes,
        warnings: parsed.warnings
      };
    });
  }

  listSubscriptions() {
    return {
      ok: true,
      manualSyncOnly: true,
      subscriptions: this.store.listSubscriptions().map((subscription) => ({
        ...subscription,
        autoUpdate: false,
        manualSyncOnly: true
      }))
    };
  }

  upsertSubscription(subscriptionInput) {
    return this._enqueueMutation(() => ({
      ok: true,
      applied: true,
      manualSyncOnly: true,
      subscription: this.store.upsertSubscription(subscriptionInput)
    }));
  }

  deleteSubscription(subscriptionId) {
    return this._enqueueMutation(() => {
      const snapshot = this.store.deleteSubscriptionWithSnapshot(subscriptionId);
      return snapshot
        ? { ok: true, applied: true, removedNodeCount: snapshot.nodes.length }
        : { ok: false, applied: false, error: 'subscription_not_found' };
    });
  }

  async syncSubscription(subscriptionId) {
    const expected = this.store.listSubscriptions()
      .find((subscription) => subscription.id === subscriptionId);
    if (!expected) return { ok: false, applied: false, error: 'subscription_not_found' };

    let fetched;
    let parsed;
    try {
      fetched = await this.subscriptionFetcher.fetch(expected.url);
      parsed = this._parseImportContent(fetched.content, expected.id);
    } catch (error) {
      return {
        ok: false,
        applied: false,
        error: String(error?.code || 'subscription_fetch_failed'),
        message: String(error?.message || '') || undefined
      };
    }
    if (!parsed.nodes.length) {
      return {
        ok: false,
        applied: false,
        error: 'no_valid_proxy_nodes_found',
        count: 0,
        skippedNodes: parsed.skippedNodes,
        warnings: parsed.warnings
      };
    }

    return this._enqueueMutation(() => {
      const current = this.store.listSubscriptions()
        .find((subscription) => subscription.id === expected.id);
      if (!current) return { ok: false, applied: false, error: 'subscription_not_found' };
      if (current.url !== expected.url || current.updatedAt !== expected.updatedAt) {
        return { ok: false, applied: false, error: 'subscription_changed_during_sync' };
      }
      const replacement = this.store.replaceSubscriptionNodesWithSnapshot(
        current.id,
        parsed.nodes,
        { sourceUrl: fetched.url }
      );
      return {
        ok: true,
        applied: true,
        storageOnly: true,
        manualSyncOnly: true,
        count: replacement.nodes.length,
        nodes: replacement.nodes.map((node) => this._toCatalogNode(node)),
        skippedNodes: parsed.skippedNodes,
        warnings: parsed.warnings
      };
    });
  }
}

let defaultService = null;

function getAccountEgressCatalogService(options) {
  if (options) return new AccountEgressCatalogService(options);
  if (!defaultService) defaultService = new AccountEgressCatalogService();
  return defaultService;
}

module.exports = {
  AccountEgressCatalogService,
  getAccountEgressCatalogService
};
