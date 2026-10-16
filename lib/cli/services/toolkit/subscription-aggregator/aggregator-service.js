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
const { CLASSIC_CLASH_PROTOCOLS, clientById, describeClients, detectClient } = require('./client-profiles');
const { buildImportLinks, importSchemes } = require('./client-import-links');
const { isLoopbackAddress, LocalClientDetector } = require('./local-client-detector');
const { selectAggregatedNodes } = require('./node-selection');
const { CUSTOM_RULE_TYPES, RESERVED_GROUP_NAMES, normalizeProfile } = require('./profile-schema');
const { getSubscriptionAggregatorStore } = require('./profile-store');
const { createProxyPoolSourcePort } = require('./proxy-pool-source-port');
const { orderEntriesByChain, resolveProxyChains } = require('./proxy-chain');
const { getLocalRelay } = require('./relay/local-relay');
const { isLoopbackHost } = require('./relay/kernel-sidecar');
const { userNameForNode } = require('./relay/relay-users');
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

/**
 * 这个输出目标的内核认不认全部协议。
 * 只有声明了本机中转回退的渲染器才需要这份清单：认不出的协议改由边车代拨。
 * 两个来源，按顺序取：
 * 1. 识别 / 模拟出的客户端自带内核清单（`classicProtocols`，Clash Premium 系 —— 格式本身输出全部协议）；
 * 2. 格式自己声明的 `coreProtocols`（Surge 系 —— 格式能表达的协议就是内核认得的协议）。
 * 都没有时按经典内核算 —— `clash-classic` 这个目标本来就是给 Premium 内核的。
 */
function coreProtocolsFor(renderer, client) {
  const capabilities = renderer && renderer.capabilities;
  if (!capabilities || !capabilities.relayFallback) return null;
  const declared = client && Array.isArray(client.classicProtocols) ? client.classicProtocols : null;
  if (declared) return declared;
  return Array.isArray(capabilities.coreProtocols) ? capabilities.coreProtocols : CLASSIC_CLASH_PROTOCOLS;
}

function protocolOf(entry) {
  return String((entry && entry.node && entry.node.protocol) || '').toLowerCase();
}

/**
 * 客户端用的那个 Host（中转入口要对它可达）。客户端能用这个地址拉到订阅，就一定连得到同一个 Host
 * 上的端口（前提是端口放行，见 AGENTS.md）。拿不到合法 Host 时返回 ''，调用方 fail-closed。
 */
function hostOfOrigin(origin) {
  try {
    const hostname = new URL(String(origin || '')).hostname;
    return hostname || '';
  } catch (_error) {
    return '';
  }
}

/** origin 的端口（缺省按协议补 80/443）；拿不到返回 0。 */
function portOfOrigin(origin) {
  try {
    const parsed = new URL(String(origin || ''));
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : 0;
  } catch (_error) {
    return 0;
  }
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
    // 本机中转边车（进程内单例）。构造时不启动任何进程，只有真正要中转时才拉起。
    this.relay = options.relay || getLocalRelay();
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
        id: entry.node.id || '',
        name: entry.name,
        protocol: String(entry.node.protocol || ''),
        region: entry.region ? entry.region.id : '',
        source: entry.sourceName,
        // 链式代理的前置节点 id（空表示直连）。
        chain: entry.node.chain || ''
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

  /**
   * 中转这次要覆盖哪些节点，以及当前状态。**同步、不起进程** —— 拉进程只在明确要求中转的路径上发生。
   * 四条规矩：
   * 1. 入口地址必须对**客户端**可达：本机请求写 127.0.0.1；远端请求写客户端用的 Host（拿不到就
   *    fail-closed，宁可跳过也不给一个连不上的地址）；
   * 2. 远端请求会要求边车绑可达地址并带认证（见 relay/kernel-sidecar 与 relay-credentials）；
   * 3. fail-closed —— 内核找不到就不给入口，渲染器于是按原样输出；
   * 4. 不要求中转时读的是**已经在跑**的边车，看到的就是客户端真会拿到的内容。
   */
  _relayPlan(profile, renderer, { requested = false, remoteAddress = '', origin = '', client = null } = {}) {
    const remote = !isLoopbackAddress(remoteAddress);
    const serverMode = typeof this.relay.serverPortMode === 'function' ? this.relay.serverPortMode() : false;
    const status = {
      requested: requested === true,
      local: !remote,
      remote,
      portMode: serverMode ? 'server' : 'dedicated',
      advertiseHost: '',
      serverPort: 0,
      available: false,
      active: false,
      candidates: 0,
      nodes: 0,
      binary: '',
      source: '',
      version: '',
      portRange: '',
      listenHost: '',
      authRequired: false,
      error: '',
      detail: '',
      skipped: []
    };
    const capabilities = renderer && renderer.capabilities;
    // 只有声明了本机中转回退的渲染器才有这条通路（见 relay-fallback）。
    if (!capabilities || !capabilities.relayFallback) return { status, candidates: null };
    const originHost = hostOfOrigin(origin);
    if (serverMode) {
      // 入口就是 AIH 自己的端口：写客户端用的那个 Host（本机就是 127.0.0.1），端口用它的端口。
      status.advertiseHost = originHost || (remote ? '' : '127.0.0.1');
      status.serverPort = portOfOrigin(origin);
      if (!status.advertiseHost || !status.serverPort) {
        status.error = 'relay_origin_unknown';
        return { status, candidates: null };
      }
    } else {
      status.advertiseHost = remote ? originHost : '127.0.0.1';
      if (!status.advertiseHost) {
        status.error = 'relay_origin_unknown';
        return { status, candidates: null };
      }
    }
    // 候选 = 目标格式编不出来的（干跑编译探测，传输/参数表达不了也算）+ 客户端内核认不出的。
    const coreProtocols = coreProtocolsFor(renderer, client);
    const probe = (entry) => {
      try {
        renderer.compileNode(entry, {});
        return true;
      } catch (_error) {
        return false;
      }
    };
    const candidates = this.relayCandidates(profile, { coreProtocols, probe });
    if (!candidates || !candidates.wanted.size) return { status, candidates: null };
    status.candidates = candidates.wanted.size;
    const availability = this.relay.availability();
    status.available = availability.available === true;
    status.binary = availability.binary || '';
    status.source = availability.source || '';
    status.version = availability.version || '';
    status.portRange = availability.portRange || '';
    if (!status.available) status.error = availability.error || 'relay_unavailable';
    return { status, candidates };
  }

  /** 本地入口 → 这次请求要写进客户端配置的条目（server 模式：同一个端口 + 用户名选节点）。 */
  _relayEndpoints(endpoints, status) {
    const mapped = new Map();
    if (status.portMode === 'server') {
      // 入口就是 AIH 自己的端口：端口号不再区分节点，用户名（由节点 id 推出）才是选择器，
      // 密码由分流器校验（lib/server/relay-port-mux）。UDP 只在前端登记了同号 UDP 入口时才声明
      // （UDP ASSOCIATE 要固定端口；没登记就是纯 TCP，UDP 由客户端按自己的策略回落）。
      const password = typeof this.relay.credentials === 'function' ? this.relay.credentials().password : '';
      const udpReady = typeof this.relay.udpEndpoint === 'function' && Boolean(this.relay.udpEndpoint());
      for (const [nodeId] of endpoints) {
        mapped.set(nodeId, {
          host: status.advertiseHost,
          port: status.serverPort,
          username: userNameForNode(nodeId),
          password,
          udp: udpReady
        });
      }
      status.authRequired = true;
      status.udpReady = udpReady;
      return mapped;
    }
    for (const [nodeId, endpoint] of endpoints) {
      if (endpoint.username) status.authRequired = true;
      mapped.set(nodeId, { ...endpoint, host: status.advertiseHost || endpoint.host });
    }
    return mapped;
  }

  /** 这次渲染能用上哪些本地入口：只读已经在跑的那一份（同步）。 */
  _relaySnapshot(plan) {
    const { status, candidates } = plan;
    if (!candidates || !status.available) return { endpoints: new Map(), status };
    const endpoints = this.relay.activeEndpoints();
    const listenHost = typeof this.relay.activeListenHost === 'function' ? this.relay.activeListenHost() : '';
    status.listenHost = listenHost || '';
    // dedicated 模式下远端客户端连不到只绑在本机的边车：不给入口（fail-closed）。
    // server 模式没有这个问题 —— 入口是 AIH 自己的端口，本来就可达。
    if (status.portMode !== 'server' && status.remote && (!listenHost || isLoopbackHost(listenHost))) {
      status.error = status.error || (endpoints.size ? 'relay_not_exposed' : 'relay_not_running');
      return { endpoints: new Map(), status };
    }
    status.nodes = endpoints.size;
    status.active = endpoints.size > 0;
    if (!status.active && status.requested) status.error = status.error || 'relay_not_running';
    return { endpoints: this._relayEndpoints(endpoints, status), status };
  }

  /** 真的把边车拉起来（会启进程）。只有明确要求中转的路径才调用。 */
  async _ensureRelay(plan) {
    const { status, candidates } = plan;
    if (!candidates || !status.available) return { endpoints: new Map(), status };
    const result = await this.relay.ensure(candidates.nodes, {
      onlyIds: candidates.wanted,
      remote: status.remote
    });
    status.nodes = result.endpoints ? result.endpoints.size : 0;
    status.active = status.nodes > 0;
    status.detail = result.detail || '';
    status.skipped = (result.skipped || []).map((item) => ({ nodeId: item.nodeId, reason: item.reason }));
    status.listenHost = typeof this.relay.activeListenHost === 'function' ? (this.relay.activeListenHost() || '') : '';
    if (result.error) status.error = result.error;
    // dedicated 模式下远端请求但边车仍绑在本机（老形态）：不给入口，免得客户端拿到连不上的地址。
    if (status.portMode !== 'server' && status.remote && isLoopbackHost(status.listenHost)) {
      status.active = false;
      status.error = status.error || 'relay_not_exposed';
      return { endpoints: new Map(), status };
    }
    return { endpoints: this._relayEndpoints(result.endpoints || new Map(), status), status };
  }

  /** 起本机中转（界面上的「启动中转」/ 预览时明确要求中转）：先起进程，再渲染。 */
  async startRelay(profileId, { target = '', client = '', remoteAddress = '', origin = '' } = {}) {
    const profile = this.store.getProfile(profileId);
    if (!profile) return { ok: false, error: 'aggregator_profile_not_found' };
    const resolvedClient = client ? clientById(client) : null;
    const renderer = getRenderer(target || resolvedClient?.target || 'mihomo');
    if (!renderer) return { ok: false, error: 'unsupported_aggregator_format' };
    const plan = this._relayPlan(profile, renderer, {
      requested: true,
      remoteAddress,
      origin,
      client: clientContext(resolvedClient)
    });
    if (!plan.candidates) return { ok: true, relay: plan.status };
    await this._ensureRelay(plan);
    return { ok: true, relay: plan.status };
  }

  /** 中转能不能用：内核在哪、版本多少、现在有没有在跑、要放行哪段端口。给界面显示用，不启动进程。 */
  relayAvailability() {
    const availability = this.relay.availability();
    return {
      ok: true,
      relay: {
        available: availability.available === true,
        binary: availability.binary || '',
        source: availability.source || '',
        version: availability.version || '',
        running: availability.running === true,
        nodes: availability.nodes || 0,
        basePort: availability.basePort || 0,
        maxPort: availability.maxPort || 0,
        portRange: availability.portRange || '',
        // server = 跟随 AIH 端口（不额外开端口）；dedicated = 每节点一个端口。
        portMode: typeof this.relay.portMode === 'function' ? this.relay.portMode() : 'dedicated',
        listenHost: availability.listenHost || '',
        authRequired: availability.authRequired === true,
        // 两个内核各自的状态：哪个缺、哪个在跑，界面与排障都要看得到。
        kernels: Array.isArray(availability.kernels) ? availability.kernels : [],
        error: availability.error || ''
      }
    };
  }

  /**
   * 哪些节点需要本机中转：
   * 1. **目标格式编不出来的**（干跑编译探测 —— 协议不支持、传输/参数表达不了都算）；
   * 2. 客户端内核认不出的协议（Clash Premium 那类「格式全输出、内核只认一部分」）。
   * 再加上它们在链上的前置。
   *
   * 前置必须一起进中转配置（只做出站、不给本地入口）：A 的链式关系落在边车里（出站 detour），
   * 前置不在配置里的话 detour 会指向不存在的 tag，边车直接拒绝整份配置。
   * 返回 { nodes, wanted }；wanted 是**节点 id**（谁要有本地入口，交给 relay.ensure 的 onlyIds），
   * nodes 是配置里要出现的全部节点。
   */
  relayCandidates(profile, { coreProtocols = null, probe = null } = {}) {
    if (!probe && (!Array.isArray(coreProtocols) || !coreProtocols.length)) return null;
    const sources = this.sources.listSources();
    const { entries } = selectAggregatedNodes(profile, sources, this.sources.listNodes());
    const { targets } = resolveProxyChains(entries);
    const nodes = [];
    const wanted = new Set();
    const seen = new Set();
    // 前置先处理：上游是不是「要进配置」决定下游要不要一起进。
    for (const entry of orderEntriesByChain(entries, targets)) {
      const upstream = targets.get(entry);
      const unsupported = !(probe ? probe(entry) : true)
        || (Array.isArray(coreProtocols) && coreProtocols.length > 0 && !coreProtocols.includes(protocolOf(entry)));
      if (!unsupported && !(upstream && seen.has(upstream))) continue;
      if (!seen.has(entry)) {
        seen.add(entry);
        nodes.push(entry.node);
      }
      if (unsupported && entry.node.id) wanted.add(entry.node.id);
      if (upstream && !seen.has(upstream)) {
        seen.add(upstream);
        nodes.push(upstream.node);
      }
    }
    return { nodes, wanted };
  }


  /** 按配置渲染一次：节点先经目标格式编译，编不出的节点不进策略组。 */
  render(profile, renderer, context = buildRenderContext({ renderer, profile })) {
    const sources = this.sources.listSources();
    const selection = selectAggregatedNodes(profile, sources, this.sources.listNodes());
    const entries = sanitizeEntryNames(selection.entries, renderer.capabilities.sanitizeName);
    const chainSyntax = renderer.capabilities.proxyChain || '';
    const { targets: chainTargets, errors: chainErrors } = resolveProxyChains(entries);
    // 这次由本机边车代拨的节点（见 relay-fallback）：它们的链式关系在边车里，渲染器只写 socks5 入口。
    const relayed = context.relay && context.relay.endpoints instanceof Map ? context.relay.endpoints : null;
    const compiledEntries = [];
    const compiledNodes = [];
    const skippedNodes = [];
    const compiled = new Set();
    // 前置节点先编译：前置编不出来的节点也跟着跳过（丢掉前置会让流量从出口节点直连）。
    for (const entry of orderEntriesByChain(entries, chainTargets)) {
      const upstream = chainTargets.get(entry);
      const chainFailure = chainErrors.get(entry)
        || (upstream && !chainSyntax ? `unsupported_proxy_chain_${renderer.id}` : '')
        || (upstream && !compiled.has(upstream) ? 'unsupported_proxy_chain_upstream_skipped' : '');
      if (chainFailure) {
        skippedNodes.push({ name: entry.name, reason: chainFailure });
        continue;
      }
      try {
        const chainName = upstream ? upstream.name : '';
        compiledNodes.push(renderer.compileNode(entry, chainName ? { ...context, chain: chainName } : context));
        compiledEntries.push(entry);
        compiled.add(entry);
      } catch (error) {
        skippedNodes.push({ name: entry.name, reason: error.code || error.message });
      }
    }
    const plan = buildAggregationPlan(profile, { entries: compiledEntries, stats: selection.stats }, sources, renderer.capabilities);
    const relayStatus = context.relay && context.relay.status;
    // 选中的节点全被目标格式丢掉（如 Surge / Clash 经典版不支持 VLESS）：问题在输出格式，
    // 不在订阅源或过滤条件。换掉 buildAggregationPlan 给的 aggregator_no_nodes，
    // 免得把用户引到「去查订阅范围/过滤」的错误方向。
    if (!compiledEntries.length && skippedNodes.length) {
      // 全是链式代理的问题时再细分一层：让用户去查前置配置，而不是去换输出格式。
      const chainBlocked = skippedNodes.every((item) => /^(?:unsupported|invalid)_proxy_chain_/.test(String(item.reason)));
      // 本机中转能带上这些节点、只是这次没在跑（内核在 + 边车没起 / 只绑在本机）：
      // 「点一下启动本机中转」比「换个输出格式」可照做得多，所以这一条优先。
      const relayBlocked = !chainBlocked && relayStatus && relayStatus.candidates > 0
        && !relayStatus.active && relayStatus.available === true;
      plan.warnings = [...plan.warnings.filter((warning) => warning !== 'aggregator_no_nodes'),
        chainBlocked ? 'aggregator_nodes_chain_blocked'
          : relayBlocked ? `aggregator_relay_unavailable:${relayStatus.error || 'relay_not_running'}`
            : 'aggregator_nodes_unsupported_by_target'];
    }
    // 目标格式输出全部协议，但这个客户端的内核只认一部分（Clash Premium）：提前说清楚，
    // 免得用户拿到一份自己的客户端根本加载不了的配置。已经交给边车代拨的节点不算 —— 那些能用。
    // 只在**认出了客户端内核**时才提醒（没认出客户端就不替用户假设内核）。
    const coreProtocols = context.client && Array.isArray(context.client.classicProtocols) ? context.client.classicProtocols : null;
    if (coreProtocols && compiledEntries.length) {
      const rejected = [...new Set(compiledEntries
        .filter((entry) => !(relayed && relayed.has(entry.node.id)))
        .map(protocolOf)
        .filter((protocol) => !coreProtocols.includes(protocol)))];
      if (rejected.length) plan.warnings = [...plan.warnings, `aggregator_client_core_protocols:${rejected.join(',')}`];
    }
    // 要中转但没起来：节点会按原样输出（内核可能加载不了），把原因带给用户。
    // 上面「全丢光」那条已经报过同一件事时不重复。
    if (relayStatus && relayStatus.candidates && relayStatus.requested && !relayStatus.active
      && !plan.warnings.some((warning) => warning.startsWith('aggregator_relay_unavailable:'))) {
      plan.warnings = [...plan.warnings, `aggregator_relay_unavailable:${relayStatus.error || 'relay_failed'}`];
    }
    // 远端客户端拿到的是「你用的 Host + 中转端口段」：dedicated 模式下那段端口必须对它可达
    // （安全组 / 防火墙 / frp 都要放行）。server 模式走 AIH 自己的端口，没有任何新端口要放行。
    if (relayStatus && relayStatus.portMode !== 'server' && relayStatus.remote && relayStatus.active && relayStatus.advertiseHost) {
      plan.warnings = [...plan.warnings,
        `aggregator_relay_remote:${relayStatus.advertiseHost}:${relayStatus.portRange || ''}`];
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

  /**
   * 预览：可以模拟某个客户端（request.client 为客户端 id），结果就是它实际拿到的内容。
   * **同步、不起进程** —— 预览读的是已经在跑的那份边车；要让中转真正起来（界面按钮 / relay=1）
   * 由调用方先走 startRelay，这样预览没有副作用，也保住「同步返回结果」的调用契约。
   */
  preview(profileId, target, request = {}) {
    const profile = this.store.getProfile(profileId);
    if (!profile) return { ok: false, error: 'aggregator_profile_not_found' };
    const client = request.client ? clientById(request.client) : null;
    if (request.client && !client) return { ok: false, error: 'unsupported_aggregator_client' };
    const renderer = getRenderer(target || client?.target || 'mihomo');
    if (!renderer) return { ok: false, error: 'unsupported_aggregator_format' };
    const clientOptions = clientContext(client);
    const coreProtocols = coreProtocolsFor(renderer, clientOptions);
    const plan = this._relayPlan(profile, renderer, {
      requested: request.relay === true,
      remoteAddress: request.remoteAddress,
      origin: request.origin,
      client: clientOptions
    });
    const relay = this._relaySnapshot(plan);
    const context = buildRenderContext({
      origin: request.origin,
      token: profile.token,
      renderer,
      profile,
      client: clientOptions,
      view: normalizeView(request.view) || client?.options.view,
      relay,
      coreProtocols
    });
    return {
      ok: true,
      ...this.render(profile, renderer, context),
      client: client ? { id: client.id, name: client.name } : null,
      view: context.view,
      relay: relay.status
    };
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
    const clientOptions = clientContext(client);
    const coreProtocols = coreProtocolsFor(renderer, clientOptions);
    // 目标格式编不出来的协议：由本机内核边车代拨（ClashX 的 VLESS、Surge 的 VLESS 都在这里）。
    // 默认自动拉起 —— 客户端在哪台机器上都行：本机请求绑回环，远端请求绑可达地址并要求认证
    // （见 relay/kernel-sidecar）。远端必须能拿到它用的 Host，否则给不出可达入口，这一轮就不中转。
    // 链接里写 ?relay=0 关掉、?relay=1 强制开。
    const canAdvertise = isLoopbackAddress(request.remoteAddress) || Boolean(hostOfOrigin(request.origin));
    const plan = this._relayPlan(profile, renderer, {
      requested: request.relay === true || (request.relay === undefined && canAdvertise),
      remoteAddress: request.remoteAddress,
      origin: request.origin,
      client: clientOptions
    });
    const relay = plan.candidates && plan.status.requested && plan.status.available
      ? await this._ensureRelay(plan)
      : this._relaySnapshot(plan);
    const context = buildRenderContext({
      origin: request.origin,
      token,
      renderer,
      profile,
      client: clientOptions,
      view: normalizeView(request.view) || client.options.view,
      relay,
      coreProtocols
    });
    const rendered = this.render(profile, renderer, context);
    this.recordPull(profile.id, {
      at: this.now(),
      clientId: client.id,
      clientName: client.name,
      format: renderer.id,
      view: context.view,
      nodes: rendered.stats.nodes,
      relayNodes: relay.status.active ? relay.status.nodes : 0,
      relayError: relay.status.active ? '' : relay.status.error
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
