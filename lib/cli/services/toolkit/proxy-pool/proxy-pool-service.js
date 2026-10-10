'use strict';

const { getProxyNodeStore, validateProxyNodeInput } = require('./proxy-node-store');
const { parseClashYamlProxiesDetailed, parseSubscriptionContent } = require('./protocol-parsers');
const { SubscriptionFetcher } = require('./subscription-fetcher');

function unsupportedSchemes(content) {
  const supported = new Set(['ss', 'vmess', 'vless', 'trojan', 'hy2', 'hysteria2', 'hysteria', 'socks', 'socks5', 'http', 'https']);
  const schemes = [];
  for (const line of String(content || '').split(/[\r\n]+/)) {
    const match = line.trim().match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (match && !supported.has(match[1].toLowerCase())) schemes.push(match[1].toLowerCase());
  }
  return [...new Set(schemes)];
}

/**
 * 订阅源服务：订阅地址的增删改与同步（拉取 → 解析 → 落节点库），只做存储，不运行任何
 * 代理内核。节点由订阅聚合器渲染成各客户端的订阅。写操作串行执行，避免并发同步互相覆盖。
 */
class ProxyPoolService {
  constructor(options = {}) {
    this.store = options.store || getProxyNodeStore(options.storeOptions);
    this.subscriptionFetcher = options.subscriptionFetcher || new SubscriptionFetcher(options.subscriptionOptions);
    this.mutationTail = Promise.resolve();
  }

  _enqueueMutation(operation) {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  // 导入只要求字段合法（协议插件声明的 fields / required）；某个输出格式编译不了的节点
  // 在渲染该格式时跳过并在预览里列出，不在这里丢弃。
  _validateNode(node) {
    validateProxyNodeInput(node);
  }

  _parseImportContent(content, subscriptionId = null) {
    const clashResult = /^\s*proxies\s*:/m.test(String(content || ''))
      ? parseClashYamlProxiesDetailed(content)
      : null;
    const parsedNodes = clashResult ? clashResult.nodes : parseSubscriptionContent(content);
    const nodes = [];
    const skippedNodes = (clashResult?.skippedNodes || []).concat(unsupportedSchemes(content).map((protocol) => ({
      nodeId: null,
      name: null,
      reason: `unsupported_proxy_protocol_${protocol}`
    })));
    for (const node of parsedNodes) {
      try {
        this._validateNode(node);
        nodes.push({ ...node, subscriptionId: subscriptionId || node.subscriptionId || null });
      } catch (error) {
        skippedNodes.push({ nodeId: node.id || null, name: node.name || null, reason: error.code || error.message });
      }
    }
    return { nodes, skippedNodes, warnings: clashResult?.warnings || [] };
  }

  listSubscriptions() {
    return { ok: true, subscriptions: this.store.listSubscriptions() };
  }

  upsertSubscription(subInput) {
    return this._enqueueMutation(() => ({ ok: true, applied: true, subscription: this.store.upsertSubscription(subInput) }));
  }

  deleteSubscription(subId) {
    return this._enqueueMutation(() => {
      const removedNodeCount = this.store.deleteSubscription(subId);
      return removedNodeCount === null
        ? { ok: false, applied: false, error: 'subscription_not_found' }
        : { ok: true, applied: true, removedNodeCount };
    });
  }

  /** 拉取并解析在队列外进行（可能很慢），落库时再确认订阅没被改过。 */
  async syncSubscription(subId) {
    const subscription = this.store.listSubscriptions().find((candidate) => candidate.id === subId);
    if (!subscription) return { ok: false, applied: false, error: 'subscription_not_found' };
    let fetched;
    let parsed;
    try {
      fetched = await this.subscriptionFetcher.fetch(subscription.url);
      parsed = this._parseImportContent(fetched.content, subscription.id);
    } catch (error) {
      return { ok: false, applied: false, error: error.code || 'subscription_fetch_failed', message: error.message };
    }
    if (!parsed.nodes.length) {
      return { ok: false, applied: false, error: 'no_valid_proxy_nodes_found', count: 0, skippedNodes: parsed.skippedNodes, warnings: parsed.warnings };
    }
    return this._enqueueMutation(() => {
      const current = this.store.listSubscriptions().find((candidate) => candidate.id === subscription.id);
      if (!current) return { ok: false, applied: false, error: 'subscription_not_found' };
      if (current.url !== subscription.url || current.updatedAt !== subscription.updatedAt) {
        return { ok: false, applied: false, error: 'subscription_changed_during_sync' };
      }
      // 订阅面板报告的流量/到期随同步落库，聚合订阅据此合并 subscription-userinfo。
      const inserted = this.store.replaceSubscriptionNodes(subscription.id, parsed.nodes, {
        sourceUrl: fetched.url,
        ...(fetched.userInfo ? { userInfo: fetched.userInfo } : {})
      });
      return {
        ok: true,
        applied: true,
        count: inserted.length,
        nodes: inserted,
        skippedNodes: parsed.skippedNodes,
        warnings: parsed.warnings
      };
    });
  }
}

let defaultService = null;

function getProxyPoolService(options) {
  if (options) return new ProxyPoolService(options);
  if (!defaultService) defaultService = new ProxyPoolService();
  return defaultService;
}

module.exports = {
  ProxyPoolService,
  getProxyPoolService,
  unsupportedSchemes
};
