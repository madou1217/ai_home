'use strict';

function publicSource(subscription) {
  const local = subscription.kind === 'local';
  return {
    id: subscription.id,
    name: subscription.name,
    kind: local ? 'local' : 'remote',
    url: local ? null : subscription.url,
    ...(local ? { content: subscription.content || '' } : { userAgent: subscription.userAgent || null }),
    nodeCount: Number(subscription.nodeCount || 0),
    lastSyncedAt: subscription.lastSyncedAt || null,
    userInfo: subscription.userInfo || null,
    // 缺省即启用（存量数据没有这个字段）。
    enabled: subscription.enabled !== false
  };
}

/**
 * 订阅源端口（Adapter）：聚合器只通过这几个方法读写订阅源，
 * 订阅与节点的唯一来源仍是代理节点库（zcode 出口也读同一份节点）。
 */
function createProxyPoolSourcePort(service) {
  const store = service.store;
  return {
    listSources() {
      return store.listSubscriptions().map(publicSource);
    },
    listNodes() {
      return store.listNodes();
    },
    /** 设置 / 清除某个节点的链式前置；节点不存在返回 null。 */
    setNodeChain(nodeId, chain) {
      return store.setNodeChain(nodeId, chain);
    },
    async saveSource(input = {}) {
      const existing = input.id ? store.listSubscriptions().find((candidate) => candidate.id === input.id) : null;
      if (input.id && !existing) return { ok: false, error: 'subscription_not_found' };
      // 节点库的 upsert 会用入参覆盖计数与同步时间，改名/改地址时要带上原值。
      const result = await service.upsertSubscription({
        ...(existing || {}),
        id: existing?.id,
        name: input.name,
        kind: input.kind || existing?.kind || 'remote',
        url: input.url,
        userAgent: input.userAgent,
        content: input.content,
        // 只在入参显式给出时覆盖（缺省保留现有启用状态）。
        ...(input.enabled === undefined ? {} : { enabled: Boolean(input.enabled) })
      });
      return { ...result, subscription: publicSource(result.subscription) };
    },
    async deleteSource(subscriptionId) {
      return service.deleteSubscription(subscriptionId);
    },
    async setSourceEnabled(subscriptionId, enabled) {
      const result = await service.setSubscriptionEnabled(subscriptionId, enabled);
      return result?.ok === false
        ? result
        : { ...result, subscription: publicSource(result.subscription) };
    },
    previewContent(content) {
      return service.previewImportContent(content);
    },
    async syncSource(subscriptionId) {
      const result = await service.syncSubscription(subscriptionId);
      const { nodes: _nodes, ...summary } = result || {};
      return summary;
    }
  };
}

module.exports = {
  createProxyPoolSourcePort,
  publicSource
};
