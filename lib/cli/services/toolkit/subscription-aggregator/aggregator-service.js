'use strict';

const {
  aggregateSubscriptionUserInfo,
  formatSubscriptionUserInfo
} = require('../proxy-pool/subscription-userinfo');
const { REGIONS, RULE_PRESETS } = require('./catalog');
const { buildAggregationPlan } = require('./aggregation-plan');
const { selectAggregatedNodes } = require('./node-selection');
const { CUSTOM_RULE_TYPES, normalizeProfile } = require('./profile-schema');
const { getSubscriptionAggregatorStore } = require('./profile-store');
const { createProxyPoolSourcePort } = require('./proxy-pool-source-port');
const { describeRenderers, detectRendererByUserAgent, getRenderer } = require('./renderers');

const DEFAULT_REFRESH_CONCURRENCY = 4;
const DEFAULT_REFRESH_DEADLINE_MS = 25000;
const HOUR_MS = 60 * 60 * 1000;

function publicProfile(profile) {
  return { ...profile, subscriptionPath: `/sub/${profile.token}` };
}

function defaultProfileTemplate() {
  const { id: _id, token: _token, createdAt: _createdAt, updatedAt: _updatedAt, ...template } = normalizeProfile({});
  return template;
}

function scopedSources(profile, sources) {
  if (profile.sources.all) return sources;
  const selected = new Set(profile.sources.subscriptionIds);
  return sources.filter((source) => selected.has(source.id));
}

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

/**
 * 订阅聚合器：把多个订阅源的节点按配置筛选、改名、编组，并按分流规则渲染成一个订阅。
 * 订阅源读写走 sourcePort（代理节点库适配器），配置走 profile store，输出格式走渲染器注册表。
 */
class SubscriptionAggregatorService {
  constructor(options = {}) {
    if (!options.sources) throw new Error('subscription_aggregator_sources_required');
    this.sources = options.sources;
    this.store = options.store || getSubscriptionAggregatorStore(options.storeOptions);
    this.now = options.now || (() => Date.now());
    this.refreshConcurrency = Number(options.refreshConcurrency || DEFAULT_REFRESH_CONCURRENCY);
    this.refreshDeadlineMs = Number(options.refreshDeadlineMs ?? DEFAULT_REFRESH_DEADLINE_MS);
    this.inFlightSyncs = new Map();
  }

  getOverview() {
    const sources = this.sources.listSources();
    const nodes = this.sources.listNodes();
    return {
      ok: true,
      profiles: this.store.listProfiles().map((profile) => ({
        ...publicProfile(profile),
        nodeCount: selectAggregatedNodes(profile, sources, nodes).entries.length
      })),
      sources,
      manualNodeCount: nodes.filter((node) => !node.subscriptionId).length,
      catalog: {
        presets: RULE_PRESETS.map(({ ruleSets: _ruleSets, ...preset }) => preset),
        regions: REGIONS.map(({ pattern: _pattern, ...region }) => region),
        formats: describeRenderers(),
        ruleTypes: CUSTOM_RULE_TYPES,
        // 新建表单的初始值直接取服务端规范化结果，前端不再维护一份默认值。
        defaultProfile: defaultProfileTemplate()
      }
    };
  }

  saveProfile(input) {
    return { ok: true, profile: publicProfile(this.store.saveProfile(input)) };
  }

  deleteProfile(profileId) {
    return this.store.deleteProfile(profileId)
      ? { ok: true }
      : { ok: false, error: 'aggregator_profile_not_found' };
  }

  rotateToken(profileId) {
    return { ok: true, profile: publicProfile(this.store.rotateToken(profileId)) };
  }

  /** 按配置渲染一次：节点先经目标格式编译，编不出的节点不进策略组。 */
  render(profile, renderer) {
    const sources = this.sources.listSources();
    const selection = selectAggregatedNodes(profile, sources, this.sources.listNodes());
    const compiledEntries = [];
    const compiledNodes = [];
    const skippedNodes = [];
    for (const entry of selection.entries) {
      try {
        compiledNodes.push(renderer.compileNode(entry));
        compiledEntries.push(entry);
      } catch (error) {
        skippedNodes.push({ name: entry.name, reason: error.code || error.message });
      }
    }
    const plan = buildAggregationPlan(profile, { entries: compiledEntries, stats: selection.stats }, sources, renderer.capabilities);
    return {
      content: renderer.render(plan, compiledNodes),
      format: renderer.id,
      contentType: renderer.contentType,
      stats: { ...plan.stats, nodes: compiledEntries.length, skipped: skippedNodes.length },
      skippedNodes,
      warnings: plan.warnings,
      userInfo: aggregateSubscriptionUserInfo(scopedSources(profile, sources).map((source) => source.userInfo))
    };
  }

  preview(profileId, target) {
    const profile = this.store.getProfile(profileId);
    if (!profile) return { ok: false, error: 'aggregator_profile_not_found' };
    const renderer = getRenderer(target || 'mihomo');
    if (!renderer) return { ok: false, error: 'unsupported_aggregator_format' };
    return { ok: true, ...this.render(profile, renderer) };
  }

  /** 同一订阅源的并发同步合并成一次（客户端拉取与 WebUI 手动同步可能同时发生）。 */
  syncSource(subscriptionId) {
    if (!this.inFlightSyncs.has(subscriptionId)) {
      const pending = Promise.resolve()
        .then(() => this.sources.syncSource(subscriptionId))
        .catch((error) => ({ ok: false, error: error.code || 'subscription_sync_failed', message: error.message }))
        .finally(() => this.inFlightSyncs.delete(subscriptionId));
      this.inFlightSyncs.set(subscriptionId, pending);
    }
    return this.inFlightSyncs.get(subscriptionId);
  }

  /** 同步一批订阅源；不传 id 即同步全部。 */
  async syncSources(subscriptionIds = []) {
    const ids = subscriptionIds.length ? subscriptionIds : this.sources.listSources().map((source) => source.id);
    const results = {};
    await runWithConcurrency(ids, this.refreshConcurrency, async (subscriptionId) => {
      results[subscriptionId] = await this.syncSource(subscriptionId);
    });
    return { ok: Object.values(results).every((result) => result?.ok !== false), results };
  }

  async saveSource(input = {}) {
    const previous = input.id ? this.sources.listSources().find((source) => source.id === input.id) : null;
    const saved = await this.sources.saveSource(input);
    if (saved.ok === false) return saved;
    if (previous && previous.url === saved.subscription.url) return saved;
    // 新增或换了地址：立即拉一次，节点数和流量信息才有意义。
    const sync = await this.syncSource(saved.subscription.id);
    return { ...saved, sync };
  }

  deleteSource(subscriptionId) {
    return this.sources.deleteSource(subscriptionId);
  }

  /** 客户端拉订阅前，把超过 refreshHours 未同步的源刷新一遍；超过期限就先用库里的节点出结果。 */
  async refreshStaleSources(profile) {
    if (!profile.refreshHours) return;
    const cutoff = this.now() - profile.refreshHours * HOUR_MS;
    const stale = scopedSources(profile, this.sources.listSources())
      .filter((source) => !source.lastSyncedAt || source.lastSyncedAt < cutoff)
      .map((source) => source.id);
    if (!stale.length) return;
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, this.refreshDeadlineMs);
    });
    await Promise.race([this.syncSources(stale), deadline]);
    clearTimeout(timer);
  }

  async serveSubscription(token, request = {}) {
    const profile = this.store.findProfileByToken(token);
    if (!profile) return { ok: false, status: 404, error: 'aggregator_subscription_not_found' };
    const renderer = request.target ? getRenderer(request.target) : detectRendererByUserAgent(request.userAgent);
    if (!renderer) return { ok: false, status: 400, error: 'unsupported_aggregator_format' };
    await this.refreshStaleSources(profile);
    const rendered = this.render(profile, renderer);
    const fileName = `${profile.name}.${renderer.extension}`;
    const headers = {
      'Content-Type': renderer.contentType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'no-store',
      'profile-title': `base64:${Buffer.from(profile.name, 'utf8').toString('base64')}`,
      'profile-update-interval': String(profile.refreshHours || 24)
    };
    const userInfo = formatSubscriptionUserInfo(rendered.userInfo);
    if (userInfo) headers['subscription-userinfo'] = userInfo;
    return { ok: true, status: 200, headers, body: rendered.content, stats: rendered.stats };
  }
}

let defaultService = null;

function getSubscriptionAggregatorService() {
  if (!defaultService) {
    // 延迟加载：代理池服务只在第一次用到聚合器时构建。
    const { getProxyPoolService } = require('../proxy-pool/proxy-pool-service');
    defaultService = new SubscriptionAggregatorService({ sources: createProxyPoolSourcePort(getProxyPoolService()) });
  }
  return defaultService;
}

module.exports = {
  SubscriptionAggregatorService,
  getSubscriptionAggregatorService,
  publicProfile
};
