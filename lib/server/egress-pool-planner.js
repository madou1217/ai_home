'use strict';

// 出口池车道规划器：账号的池绑定（节点范围 + 策略）× 上游地区判定 → 车道表。
//
// 设计（docs/plans/2026-10-19-account-egress-upstream-policy.md §P2）：
//   - 每个车道 = 内核里一个 select 组 + 一个回环入站（egress-pool-runtime）。规划器只决定
//     「哪些账号共用哪个车道、车道能用哪些节点」，节点切换由运行时执行；
//   - 车道键：shared = 上游 × 节点范围（同上游同范围的账号共享一条轮换）；sticky = 账号独占，
//     同上游的独占车道彼此错开出口（avoidGroup = 上游）；
//   - 可用节点 = 节点范围 ∩ 地区判定不为 denied（egress-region-policy 的 evaluateExit）。
//     上游存在按位置判定的规则/提示时，**位置未知的节点不放行**（等位置查到再说），
//     这是「坚决不允许」的落点：宁可短暂无出口，也不让 claude 账号先走一次香港节点；
//   - 车道不够时先把独占降成共享，再不够的账号由运行时按溢出 fail-closed。
//
// 触发：池就绪、绑定写入、上游策略 / 实测写入、以及周期对账（server 里的定时器）。

const nodeFs = require('node:fs');
const nodeCrypto = require('node:crypto');

const { EGRESS_MODE_POOL, listAccountEgressBindings } = require('../account/zcode-egress-binding-store');
const { readEgressPoolCatalog } = require('../runtime/egress-pool-node-source');
const { evaluateExit, nodeExitKey } = require('./egress-region-policy');
const { readUpstreamDecisionContext, resolveAccountUpstream } = require('./egress-upstream');
const { decideNode, readNodePolicy } = require('../runtime/egress-pool-node-policy');

const { EGRESS_POOL_SESSION_LANES } = require('../cli/config/constants');

const CATALOG_CACHE_MS = 60 * 1000;
const GEO_FIELDS = ['country', 'region', 'city', 'asn', 'cidr'];

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasGeoField(rule) {
  return Boolean(rule && rule.match && GEO_FIELDS.some((field) => rule.match[field] && rule.match[field].length));
}

function scopeKey(scope) {
  const kind = scope && scope.kind ? scope.kind : 'all';
  if (kind === 'all') return 'all';
  const items = [...(kind === 'groups' ? scope.groups : scope.nodes) || []].sort();
  return `${kind}-${nodeCrypto.createHash('sha1').update(items.join('\n')).digest('hex').slice(0, 10)}`;
}

/** 运行池里找账号记录（拿 provider / apiKeyMode / baseUrl 推导上游）。 */
function indexAccounts(pools) {
  const byRef = new Map();
  Object.values(pools && typeof pools === 'object' ? pools : {}).forEach((pool) => {
    (Array.isArray(pool) ? pool : []).forEach((account) => {
      const ref = normalizeString(account && account.accountRef);
      if (ref && !byRef.has(ref)) byRef.set(ref, account);
    });
  });
  return byRef;
}

/**
 * 某上游下每个节点的判定（规划与 WebUI 共用，保证两边结论一致）。
 * @param {object} input { upstream, policy, evidence, hints, ttlMs, nodes: [{name, identity, geo, groups:Set}] }
 * @returns {Map<name, verdict & { geoPending: boolean }>}
 */
function evaluateNodesForUpstream(input) {
  const rules = (input.policy && input.policy.rules) || [];
  const hints = input.hints || [];
  const geoRules = rules.some(hasGeoField) || hints.some(hasGeoField);
  const out = new Map();
  (input.nodes || []).forEach((node) => {
    const verdict = evaluateExit({
      exit: { identity: node.identity, geo: node.geo || null, groups: node.groups },
      rules,
      hints,
      evidence: input.evidence,
      exitKey: nodeExitKey(node.identity),
      evidenceTtlMs: input.ttlMs,
      now: input.now
    });
    // 位置未知 + 上游有按位置的规则：只有实测 / 节点规则能放行它，否则先挂起。
    const geoPending = geoRules && !(node.geo && node.geo.country) && verdict.source === 'none';
    out.set(node.name, { ...verdict, geoPending });
  });
  return out;
}

function sessionLaneKey(accountRef, slot) {
  return `session:${accountRef}:${slot}`;
}

function createEgressPoolPlanner(deps = {}) {
  const fs = deps.fs || nodeFs;
  const aiHomeDir = normalizeString(deps.aiHomeDir);
  const getService = typeof deps.getService === 'function' ? deps.getService : () => null;
  const getPools = typeof deps.getPools === 'function' ? deps.getPools : () => ({});
  const getServerOptions = typeof deps.getServerOptions === 'function' ? deps.getServerOptions : () => ({});
  const listBindings = typeof deps.listBindings === 'function' ? deps.listBindings : listAccountEgressBindings;
  const readCatalog = typeof deps.readCatalog === 'function'
    ? deps.readCatalog
    : () => readEgressPoolCatalog({ fs, aiHomeDir, env: deps.env });
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};
  let catalogCache = null;
  let catalogAt = 0;
  let lastPlan = [];
  let lastSignature = '';
  let lastUpstreams = new Map();

  function catalogGroups() {
    if (!catalogCache || now() - catalogAt > CATALOG_CACHE_MS) {
      try {
        const catalog = readCatalog();
        catalogCache = catalog && catalog.ok ? catalog.groups || [] : [];
      } catch (_error) {
        catalogCache = [];
      }
      catalogAt = now();
    }
    return catalogCache;
  }

  /** 运行时的节点表（名字 + 出口身份 + 位置 + 所属自建分组）。 */
  function runtimeNodes(runtime) {
    const health = runtime && runtime.health;
    if (!health || !Array.isArray(health.nodes)) return [];
    const groups = catalogGroups();
    return health.nodes.map((node) => ({
      name: node.name,
      identity: node.identity,
      label: node.label,
      geo: typeof health.geoOf === 'function' ? health.geoOf(node.name) : null,
      groups: new Set(groups.filter((group) => group.identities.includes(node.identity)).map((group) => group.id))
    }));
  }

  /**
   * 拦截策略挡住的节点（延迟阈值 / 探测不通 / 手动关闭）。判定与轮换同一份
   * （egress-pool-node-policy.decideNode，账本提供探测结果）：规划出来的车道里不出现这些节点，
   * 这样即使运行时还没来得及重选，车道也不会指向一个被拦的出口。
   * 策略读不到时返回空集合（不拦截），绝不因为策略问题让所有车道空掉。
   */
  function blockedNodes(runtime) {
    const health = runtime && runtime.health;
    const out = new Set();
    if (!health || typeof health.blockedReason !== 'function') return out;
    let policy = null;
    try {
      policy = readNodePolicy(fs, aiHomeDir);
    } catch (_error) {
      return out;
    }
    if (!policy) return out;
    (health.nodes || []).forEach((node) => {
      const stats = typeof health.statsFor === 'function' ? health.statsFor(node.name) : null;
      const verdict = decideNode({ policy, identity: node.identity, probe: stats ? stats.probe : null });
      if (verdict.status === 'blocked') out.add(node.name);
    });
    return out;
  }

  /** 上游判定上下文（策略 + 实测 + 提示 + 有效期），按上游缓存在一次规划内。 */
  function upstreamContext(upstream, cache) {
    if (!upstream) return null;
    if (cache.has(upstream.id)) return cache.get(upstream.id);
    const context = readUpstreamDecisionContext(fs, aiHomeDir, upstream);
    cache.set(upstream.id, context);
    return context;
  }

  /**
   * 计算车道表（纯计算 + 只读存储，不改运行时）。
   * @returns {{ plan: Array, accounts: Map<accountRef, object> }}
   */
  function computePlan() {
    const service = getService();
    const runtime = service && service.runtime;
    const nodes = runtimeNodes(runtime);
    const blocked = blockedNodes(runtime);
    const slots = runtime && Array.isArray(runtime.lanes) ? runtime.lanes.length : 0;
    let bindings = [];
    try {
      bindings = listBindings(fs, aiHomeDir).filter((entry) => entry.binding && entry.binding.mode === EGRESS_MODE_POOL && !entry.binding.retired);
    } catch (_error) {
      bindings = [];
    }
    const accounts = indexAccounts(getPools());
    const groups = catalogGroups();
    const contexts = new Map();
    const options = getServerOptions() || {};
    const perAccount = new Map();
    const lanes = new Map();
    const upstreams = new Map();

    bindings.forEach(({ accountRef, provider, binding }) => {
      const account = accounts.get(accountRef) || { accountRef, provider };
      const upstream = resolveAccountUpstream(options, account);
      if (upstream) upstreams.set(upstream.id, upstream);
      const scope = binding.scope || { kind: 'all', groups: [], nodes: [] };
      let scopeIdentities = null;
      if (scope.kind === 'groups') {
        scopeIdentities = new Set(groups.filter((group) => scope.groups.includes(group.id)).flatMap((group) => group.identities));
      } else if (scope.kind === 'nodes') {
        scopeIdentities = new Set(scope.nodes);
      }
      const inScope = nodes.filter((node) => !scopeIdentities || scopeIdentities.has(node.identity));
      const context = upstreamContext(upstream, contexts);
      const verdicts = context ? evaluateNodesForUpstream({ ...context, nodes: inScope, now: now() }) : new Map();
      const allowed = inScope.filter((node) => {
        // 拦截策略优先于地区判定：被拦的节点不进车道（它可能慢到根本发不出请求）。
        if (blocked.has(node.name)) return false;
        const verdict = verdicts.get(node.name);
        return !verdict || (verdict.status !== 'denied' && !verdict.geoPending);
      }).map((node) => node.name);
      const blockedCount = inScope.filter((node) => blocked.has(node.name)).length;
      const pending = inScope.filter((node) => (verdicts.get(node.name) || {}).geoPending).length;
      const denied = inScope.filter((node) => (verdicts.get(node.name) || {}).status === 'denied').length;
      const strategy = ['sticky', 'session'].includes(binding.strategy) ? binding.strategy : 'shared';
      const upstreamId = upstream ? upstream.id : 'unknown';
      const sharedKey = `shared:${upstreamId}:${scopeKey(scope)}`;
      const key = strategy === 'sticky' ? `sticky:${accountRef}` : (strategy === 'session' ? sessionLaneKey(accountRef, 0) : sharedKey);
      let blockedReason = '';
      if (inScope.length === 0) blockedReason = 'egress_pool_scope_empty';
      else if (allowed.length === 0) {
        // 全被拦截时给的原因要让用户知道去关拦截，而不是去查地区策略。
        blockedReason = blockedCount === inScope.length ? 'egress_pool_all_nodes_blocked'
          : pending > 0 ? 'egress_pool_geo_pending'
            : 'egress_region_denied_all_nodes';
      }
      perAccount.set(accountRef, {
        accountRef, provider, upstream: upstreamId, strategy, key, sharedKey,
        scopeKind: scope.kind, inScope: inScope.length, allowed: allowed.length, denied, pending, blockedCount, blockedReason
      });
      const baseLane = {
        accounts: [accountRef],
        allowed,
        scopeNames: inScope.map((node) => node.name),
        strategy,
        upstream: upstreamId,
        blockedReason
      };
      if (strategy === 'session') {
        // 会话独占：同一账号预留多条车道（彼此错开节点），本地 CLI 会话各认领一条（见 egress-pool-session-lease）。
        // 车道数不超过可用节点数：节点比车道少时多出来的车道只会重复用同一个出口。
        const count = Math.max(1, Math.min(EGRESS_POOL_SESSION_LANES, allowed.length || 1));
        for (let slot = 0; slot < count; slot += 1) {
          const slotKey = sessionLaneKey(accountRef, slot);
          lanes.set(slotKey, { ...baseLane, key: slotKey, avoidGroup: `session:${accountRef}`, sessionSlot: slot });
        }
        return;
      }
      const lane = lanes.get(key) || {
        ...baseLane,
        key,
        accounts: [],
        avoidGroup: strategy === 'sticky' ? upstreamId : ''
      };
      lane.accounts.push(accountRef);
      lanes.set(key, lane);
    });

    // 车道不够：先收缩会话车道（每个账号至少留 1 条，从最高槽位开始收）。
    if (slots > 0 && lanes.size > slots) {
      const sessionLanes = [...lanes.values()].filter((lane) => lane.strategy === 'session' && lane.sessionSlot > 0)
        .sort((a, b) => b.sessionSlot - a.sessionSlot);
      for (const lane of sessionLanes) {
        if (lanes.size <= slots) break;
        lanes.delete(lane.key);
        const info = perAccount.get(lane.accounts[0]);
        if (info) info.sessionLanesReduced = true;
      }
    }

    // 车道不够：独占降成共享（同上游同范围合并），保证每个账号都有车道。
    if (slots > 0 && lanes.size > slots) {
      [...lanes.values()].filter((lane) => lane.strategy === 'sticky').forEach((lane) => {
        if (lanes.size <= slots) return;
        lanes.delete(lane.key);
        lane.accounts.forEach((accountRef) => {
          const info = perAccount.get(accountRef);
          const shared = lanes.get(info.sharedKey) || { ...lane, key: info.sharedKey, accounts: [], avoidGroup: '', strategy: 'shared' };
          shared.accounts.push(accountRef);
          lanes.set(info.sharedKey, shared);
          info.key = info.sharedKey;
          info.downgraded = true;
        });
      });
    }
    lastUpstreams = upstreams;
    return { plan: [...lanes.values()], accounts: perAccount, nodes, upstreams };
  }

  function signatureOf(plan) {
    return JSON.stringify(plan.map((lane) => [lane.key, lane.accounts.slice().sort(), lane.allowed.slice().sort(), lane.avoidGroup, lane.blockedReason, lane.sessionSlot]));
  }

  /** 同步规划并把车道分配交给运行时（节点选择异步完成）。返回本次规划。 */
  function planNow() {
    const service = getService();
    const computed = computePlan();
    lastPlan = computed.plan;
    const signature = signatureOf(computed.plan);
    if (service && typeof service.applyLanePlan === 'function' && signature !== lastSignature) {
      lastSignature = signature;
      service.applyLanePlan(computed.plan).catch(() => {});
      logger(`egress-pool lanes: ${computed.plan.length} lane(s) for ${computed.accounts.size} account(s)`);
    }
    return computed;
  }

  /** 强制重新规划（策略 / 实测 / 分组变化后）。 */
  function reconcile(options = {}) {
    if (options.refreshCatalog) catalogCache = null;
    lastSignature = options.force ? '' : lastSignature;
    try {
      return planNow();
    } catch (error) {
      logger(`egress-pool planner failed: ${String((error && error.message) || error)}`);
      return null;
    }
  }

  return {
    computePlan,
    planNow,
    reconcile,
    evaluateNodesForUpstream,
    upstreamContext: (upstream) => upstreamContext(upstream, new Map()),
    upstreamContextById: (id) => upstreamContext(lastUpstreams.get(id), new Map()),
    runtimeNodes: () => runtimeNodes((getService() || {}).runtime),
    catalogGroups,
    get lastPlan() { return lastPlan; }
  };
}

module.exports = {
  createEgressPoolPlanner,
  evaluateNodesForUpstream,
  scopeKey
};
