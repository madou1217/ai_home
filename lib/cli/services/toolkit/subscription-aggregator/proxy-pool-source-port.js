'use strict';

function publicSource(subscription) {
  return {
    id: subscription.id,
    name: subscription.name,
    url: subscription.url,
    nodeCount: Number(subscription.nodeCount || 0),
    lastSyncedAt: subscription.lastSyncedAt || null,
    userInfo: subscription.userInfo || null
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
    async saveSource(input = {}) {
      const existing = input.id ? store.listSubscriptions().find((candidate) => candidate.id === input.id) : null;
      if (input.id && !existing) return { ok: false, error: 'subscription_not_found' };
      // 节点库的 upsert 会用入参覆盖计数与同步时间，改名/改地址时要带上原值。
      const result = await service.upsertSubscription({
        ...(existing || {}),
        id: existing?.id,
        name: input.name,
        url: input.url
      });
      return { ...result, subscription: publicSource(result.subscription) };
    },
    async deleteSource(subscriptionId) {
      return service.deleteSubscription(subscriptionId);
    },
    async syncSource(subscriptionId) {
      const result = await service.syncSubscription(subscriptionId);
      const { nodes: _nodes, ...summary } = result || {};
      return summary;
    }
  };
}

module.exports = {
  createProxyPoolSourcePort
};
