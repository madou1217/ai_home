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
        kind: input.kind || existing?.kind || 'remote',
        url: input.url,
        userAgent: input.userAgent,
        content: input.content
      });
      return { ...result, subscription: publicSource(result.subscription) };
    },
    async deleteSource(subscriptionId) {
      return service.deleteSubscription(subscriptionId);
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
  createProxyPoolSourcePort
};
