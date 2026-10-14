'use strict';

const { SUPPORTED_PROTOCOLS } = require('../proxy-pool/protocols');
const { MAX_LOCAL_SUBSCRIPTION_BYTES } = require('../proxy-pool/proxy-node-store');
const { DEFAULT_USER_AGENT } = require('../proxy-pool/subscription-fetcher');
const {
  aggregateSubscriptionUserInfo,
  formatSubscriptionUserInfo
} = require('../proxy-pool/subscription-userinfo');
const { GROUP_TYPE_INFO, LOAD_BALANCE_STRATEGY_INFO, REGIONS, RULE_PRESETS } = require('./catalog');
const { buildAggregationPlan } = require('./aggregation-plan');
const { clientById, describeClients, detectClient } = require('./client-profiles');
const { buildImportLinks, importSchemes } = require('./client-import-links');
const { LocalClientDetector } = require('./local-client-detector');
const { selectAggregatedNodes } = require('./node-selection');
const { CUSTOM_RULE_TYPES, RESERVED_GROUP_NAMES, normalizeProfile } = require('./profile-schema');
const { getSubscriptionAggregatorStore } = require('./profile-store');
const { createProxyPoolSourcePort } = require('./proxy-pool-source-port');
const { buildRenderContext, normalizeView } = require('./render-context');
const { describeRenderers, getRenderer } = require('./renderers');
const { NodeToolsService } = require('./node-tools');
const { traceRoute } = require('./route-tester');
const { RuleSetConverter } = require('./rule-set-converter');

const DEFAULT_REFRESH_CONCURRENCY = 4;
const DEFAULT_REFRESH_DEADLINE_MS = 25000;
const HOUR_MS = 60 * 60 * 1000;
// 每个聚合订阅记住最近的拉取（只在内存里，用来核对客户端识别），不落盘。
const MAX_RECENT_PULLS = 20;

function clientContext(client) {
  return client ? { id: client.id, name: client.name, ...client.options } : null;
}

function publicProfile(profile) {
  return { ...profile, subscriptionPath: `/sub/${profile.token}` };
}

function defaultProfileTemplate() {
  const { id: _id, token: _token, createdAt: _createdAt, updatedAt: _updatedAt, ...template } = normalizeProfile({});
  return template;
}

// 决定同步结果的来源参数：任何一项变了都要重新同步。
function sourceSignature(source) {
  return JSON.stringify([source.kind, source.url, source.userAgent || null, source.content ?? null]);
}

function scopedSources(profile, sources) {
  if (profile.sources.all) return sources;
  const selected = new Set(profile.sources.subscriptionIds);
  return sources.filter((source) => selected.has(source.id));
}

// 节点名按目标格式清洗（例如 Surge / QX 的名字不能含逗号），清洗后重名的再加序号。
function sanitizeEntryNames(entries, sanitizeName) {
  if (typeof sanitizeName !== 'function') return entries;
  const used = new Set();
  return entries.map((entry) => {
    const base = sanitizeName(entry.name) || 'node';
    let name = base;
    for (let counter = 2; used.has(name); counter += 1) name = `${base} ${counter}`;
    used.add(name);
    return name === entry.name ? entry : { ...entry, name };
  });
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
    this.ruleSets = options.ruleSets || new RuleSetConverter();
    this.recentPulls = new Map();
    this.localClients = options.localClients || new LocalClientDetector();
    this.nodeTools = options.nodeTools || new NodeToolsService({ sources: this.sources });
  }

  recordPull(profileId, pull) {
    const pulls = [pull, ...(this.recentPulls.get(profileId) || [])].slice(0, MAX_RECENT_PULLS);
    this.recentPulls.set(profileId, pulls);
  }

  getOverview() {
    const sources = this.sources.listSources();
    const nodes = this.sources.listNodes();
    return {
      ok: true,
      profiles: this.store.listProfiles().map((profile) => ({
        ...publicProfile(profile),
        nodeCount: selectAggregatedNodes(profile, sources, nodes).entries.length,
        recentPulls: this.recentPulls.get(profile.id) || []
      })),
      sources,
      manualNodeCount: nodes.filter((node) => !node.subscriptionId).length,
      catalog: {
        presets: RULE_PRESETS.map(({ ruleSets: _ruleSets, ...preset }) => preset),
        regions: REGIONS.map(({ pattern: _pattern, ...region }) => region),
        formats: describeRenderers(),
        clients: describeClients(),
        protocols: [...SUPPORTED_PROTOCOLS],
        defaultUserAgent: DEFAULT_USER_AGENT,
        ruleTypes: CUSTOM_RULE_TYPES,
        groupTypes: GROUP_TYPE_INFO,
        loadBalanceStrategies: LOAD_BALANCE_STRATEGY_INFO,
        // 自动生成的组名，自建组不能用（前端就地校验，保存时服务端同样拒绝）。
        reservedGroupNames: [...RESERVED_GROUP_NAMES],
        protocolForms: this.nodeTools.protocolForms(),
        // 新建表单的初始值直接取服务端规范化结果，前端不再维护一份默认值。
        defaultProfile: defaultProfileTemplate()
      }
    };
  }

  /**
   * 编辑中（未保存）的配置会选中哪些节点：给自建策略组勾选节点、实时匹配名称规则用。
   * 只取影响选点的部分（订阅源范围、过滤、改名、去重），策略组与规则编辑到一半也不影响。
   */
  previewNodes(input = {}) {
    const draft = input && typeof input === 'object' ? input : {};
    const profile = normalizeProfile({ sources: draft.sources, filter: draft.filter, naming: draft.naming, dedupe: draft.dedupe }, null, this.now());
    const { entries } = selectAggregatedNodes(profile, this.sources.listSources(), this.sources.listNodes());
    return {
      ok: true,
      nodes: entries.map((entry) => ({
        name: entry.name,
        protocol: String(entry.node.protocol || ''),
        region: entry.region ? entry.region.id : '',
        source: entry.sourceName
      }))
    };
  }

  saveProfile(input) {
    return { ok: true, profile: publicProfile(this.store.saveProfile(input)) };
  }

  deleteProfile(profileId) {
    if (!this.store.deleteProfile(profileId)) return { ok: false, error: 'aggregator_profile_not_found' };
    this.recentPulls.delete(profileId);
    return { ok: true };
  }

  /** 某个聚合订阅在指定地址下的导入方式（通用地址 + 各客户端深链接）。 */
  importLinks(profileId, origin) {
    const profile = this.store.getProfile(profileId);
    if (!profile) return { ok: false, error: 'aggregator_profile_not_found' };
    const links = buildImportLinks({ origin, token: profile.token, name: profile.name });
    return links ? { ok: true, ...links } : { ok: false, error: 'invalid_aggregator_origin' };
  }

  /** 本机装了哪些客户端（按 URL Scheme 查处理程序）；local=false 时调用方不在这台机器上。 */
  async detectLocalClients({ local }) {
    if (!local) return { ok: true, local: false, handlers: {} };
    return { ok: true, local: true, handlers: await this.localClients.detect(importSchemes()) };
  }

  rotateToken(profileId) {
    return { ok: true, profile: publicProfile(this.store.rotateToken(profileId)) };
  }

  /** 按配置渲染一次：节点先经目标格式编译，编不出的节点不进策略组。 */
  render(profile, renderer, context = buildRenderContext({ renderer, profile })) {
    const sources = this.sources.listSources();
    const selection = selectAggregatedNodes(profile, sources, this.sources.listNodes());
    const entries = sanitizeEntryNames(selection.entries, renderer.capabilities.sanitizeName);
    const compiledEntries = [];
    const compiledNodes = [];
    const skippedNodes = [];
    for (const entry of entries) {
      try {
        compiledNodes.push(renderer.compileNode(entry, context));
        compiledEntries.push(entry);
      } catch (error) {
        skippedNodes.push({ name: entry.name, reason: error.code || error.message });
      }
    }
    const plan = buildAggregationPlan(profile, { entries: compiledEntries, stats: selection.stats }, sources, renderer.capabilities);
    // 选中的节点全被目标格式丢掉（如 Clash 经典版不支持 VLESS）：问题在输出格式，不在订阅源或过滤条件。
    // 换掉 buildAggregationPlan 给的 aggregator_no_nodes，免得把用户引到「去查订阅范围/过滤」的错误方向。
    if (!compiledEntries.length && skippedNodes.length) {
      plan.warnings = [...plan.warnings.filter((warning) => warning !== 'aggregator_no_nodes'), 'aggregator_nodes_unsupported_by_target'];
    }
    // 节点视图不输出策略组与规则，统计里也不算。
    const layout = context.view === 'nodes' ? { groups: 0, regions: 0, rules: 0 } : {};
    return {
      content: renderer.render(plan, compiledNodes, context),
      format: renderer.id,
      contentType: renderer.contentType,
      stats: { ...plan.stats, ...layout, nodes: compiledEntries.length, skipped: skippedNodes.length },
      skippedNodes,
      warnings: plan.warnings,
      userInfo: aggregateSubscriptionUserInfo(scopedSources(profile, sources).map((source) => source.userInfo))
    };
  }

  /** 预览：可以模拟某个客户端（request.client 为客户端 id），结果就是它实际拿到的内容。 */
  preview(profileId, target, request = {}) {
    const profile = this.store.getProfile(profileId);
    if (!profile) return { ok: false, error: 'aggregator_profile_not_found' };
    const client = request.client ? clientById(request.client) : null;
    if (request.client && !client) return { ok: false, error: 'unsupported_aggregator_client' };
    const renderer = getRenderer(target || client?.target || 'mihomo');
    if (!renderer) return { ok: false, error: 'unsupported_aggregator_format' };
    const context = buildRenderContext({
      origin: request.origin,
      token: profile.token,
      renderer,
      profile,
      client: clientContext(client),
      view: normalizeView(request.view) || client?.options.view
    });
    return { ok: true, ...this.render(profile, renderer, context), client: client ? { id: client.id, name: client.name } : null, view: context.view };
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
    if (previous && sourceSignature(previous) === sourceSignature(saved.subscription)) return saved;
    // 新增，或地址 / User-Agent / 本地内容变了：立即同步一次，节点数和流量信息才有意义。
    const sync = await this.syncSource(saved.subscription.id);
    return { ...saved, sync };
  }

  deleteSource(subscriptionId) {
    return this.sources.deleteSource(subscriptionId);
  }

  /**
   * 解析预览：粘贴或拖入的本地内容会识别成什么格式、导入哪些节点、跳过哪些（原因），不保存。
   * 上限与本地订阅源相同（2 MiB）。
   */
  previewSource(input = {}) {
    const content = typeof input?.content === 'string' ? input.content : '';
    if (!content.trim()) return { ok: false, error: 'invalid_subscription_content' };
    if (Buffer.byteLength(content, 'utf8') > MAX_LOCAL_SUBSCRIPTION_BYTES) return { ok: false, error: 'subscription_content_too_large' };
    const parsed = this.sources.previewContent(content);
    return {
      ok: true,
      format: parsed.format || '',
      nodes: parsed.nodes.map((node) => ({
        name: node.name,
        protocol: node.protocol,
        server: node.server,
        port: node.port,
        flag: node.countryFlag || ''
      })),
      skippedNodes: parsed.skippedNodes.map((item) => ({ name: item.name || '', reason: item.reason })),
      warnings: parsed.warnings || []
    };
  }

  /** 客户端拉订阅前，把超过 refreshHours 未同步的源刷新一遍；超过期限就先用库里的节点出结果。 */
  async refreshStaleSources(profile) {
    if (!profile.refreshHours) return;
    const cutoff = this.now() - profile.refreshHours * HOUR_MS;
    // 本地订阅保存时已解析，不需要定时刷新。
    const stale = scopedSources(profile, this.sources.listSources())
      .filter((source) => source.kind !== 'local')
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
    // 识别出的客户端决定默认格式；即使链接里写了 ?target，它的内核版本、视图等选项也照样生效。
    const client = detectClient(request.userAgent);
    const renderer = getRenderer(request.target || client.target);
    if (!renderer) return { ok: false, status: 400, error: 'unsupported_aggregator_format' };
    await this.refreshStaleSources(profile);
    const context = buildRenderContext({
      origin: request.origin,
      token,
      renderer,
      profile,
      client: clientContext(client),
      view: normalizeView(request.view) || client.options.view
    });
    const rendered = this.render(profile, renderer, context);
    this.recordPull(profile.id, {
      at: this.now(),
      clientId: client.id,
      clientName: client.name,
      format: renderer.id,
      view: context.view,
      nodes: rendered.stats.nodes
    });
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

  /**
   * 规则测试：编辑中（未保存）的配置下，一个域名或 IP 会命中哪条规则、走到哪个策略组。
   * 规则集内容与规则集转换共用缓存，第一次测试可能要等几秒下载。
   */
  async testRoute(input = {}) {
    const request = input && typeof input === 'object' ? input : {};
    const profile = normalizeProfile(request.profile, null, this.now());
    const sources = this.sources.listSources();
    const plan = buildAggregationPlan(profile, selectAggregatedNodes(profile, sources, this.sources.listNodes()), sources);
    const result = await traceRoute(plan, request.target, { loadEntries: (ruleSet) => this.ruleSets.loadEntries(ruleSet) });
    return { ok: true, ...result };
  }

  /**
   * 规则集转换：只服务该订阅实际用到的规则集（标签来自聚合规划），目标格式决定规则集语法。
   */
  async serveRuleSet(token, tag, request = {}) {
    const profile = this.store.findProfileByToken(token);
    if (!profile) return { ok: false, status: 404, error: 'aggregator_subscription_not_found' };
    const renderer = getRenderer(request.target);
    const format = renderer && renderer.capabilities.ruleSetFormat;
    if (!format) return { ok: false, status: 400, error: 'unsupported_aggregator_format' };
    const plan = buildAggregationPlan(profile, { entries: [] }, this.sources.listSources(), renderer.capabilities);
    const ruleSet = plan.ruleSets.find((candidate) => candidate.tag === tag);
    if (!ruleSet) return { ok: false, status: 404, error: 'aggregator_rule_set_not_found' };
    try {
      const body = await this.ruleSets.render(ruleSet, format);
      return {
        ok: true,
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
        body
      };
    } catch (error) {
      return { ok: false, status: 502, error: error.code || 'aggregator_rule_set_fetch_failed' };
    }
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
