'use strict';

// 出口池节点账本：每个节点被谁用过、成功/失败多少次、为什么失败、冷却到什么时候、
// 最近一次恢复探测的结果，以及一条有限长度的事件流（切换 / 失败 / 冷却 / 恢复）。
//
// 为什么需要（2026-10-19）：池原来是纯轮询 —— 只记「当前第几个节点」。被限的节点下一轮
// 照样再撞一次，没有冷却、没有恢复探测，也没有任何地方能看到「哪个账号用了哪个节点、
// 哪个节点为什么不可用」。这个模块是这些问题的单一事实来源：
//   - 轮换据它跳过冷却中的节点（pickNext）；
//   - 恢复探测据它决定探谁、探完怎么改状态（dueForProbe / recordProbe）；
//   - WebUI 的出口池面板只读它的快照（snapshot）。
//
// 节点身份：池里的 `node-N` 只是本次启动的序号（节点增删后会变），账本按**出口身份**
// （协议 + 服务器 + 端口）记，重启/节点顺序变化后历史仍对得上。
// 持久化：`<aiHome>/run/egress-pool/node-health.json`（0600，与池配置同目录），只存统计与
// 冷却，不存节点凭据。写盘节流，失败只丢统计、不影响请求。

const nodePath = require('node:path');
const {
  EGRESS_POOL_NODE_FREE_LIMIT_COOLDOWN_MS,
  EGRESS_POOL_NODE_GATE_COOLDOWN_MS,
  EGRESS_POOL_NODE_NETWORK_COOLDOWN_MS,
  EGRESS_POOL_NODE_MAX_COOLDOWN_MS,
  EGRESS_POOL_EVENT_HISTORY
} = require('../cli/config/constants');
const { decideNode } = require('./egress-pool-node-policy');
const { buildNodeEntityId } = require('./egress-node-identity');

const HEALTH_FILE_NAME = 'node-health.json';
const HEALTH_FILE_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 2000;
const MAX_ACCOUNTS_PER_NODE = 20;

// 失败类别 → 冷却基准。类别名同时出现在事件流与 UI 上。
const FAILURE_KINDS = Object.freeze({
  free_limit: EGRESS_POOL_NODE_FREE_LIMIT_COOLDOWN_MS,
  gate: EGRESS_POOL_NODE_GATE_COOLDOWN_MS,
  network: EGRESS_POOL_NODE_NETWORK_COOLDOWN_MS
});
// IP/地区拒绝证据 is account/upstream scoped and is deliberately absent from
// this global node ledger. Only network reachability and the existing node
// policy may affect all users of a node.
const FIXED_COOLDOWN_KINDS = new Set();

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 出口身份：与 egress-pool-node-source 的去重键同口径（不含凭据，凭据不进账本文件）。 */
function exitIdentity(node) {
  if (!node || typeof node !== 'object') return '';
  const server = normalizeString(String(node.server || '')).toLowerCase();
  const port = Number(node.port);
  if (!server || !Number.isInteger(port)) return '';
  return `${normalizeString(String(node.protocol || '')).toLowerCase()}|${server}|${port}`;
}

function emptyStats() {
  return {
    uses: 0,
    successes: 0,
    failures: 0,
    failuresByKind: {},
    consecutiveFailures: 0,
    lastUsedAt: 0,
    lastSuccessAt: 0,
    lastFailureAt: 0,
    lastFailureKind: '',
    cooldownUntil: 0,
    cooldownKind: '',
    probe: null,
    geo: null,
    accounts: {}
  };
}

class EgressPoolNodeHealth {
  constructor(options = {}) {
    this.fs = options.fs || null;
    this.path = options.path || nodePath;
    this.aiHomeDir = normalizeString(options.aiHomeDir);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.eventLimit = Number(options.eventLimit) > 0 ? Number(options.eventLimit) : EGRESS_POOL_EVENT_HISTORY;
    // 节点拦截策略（延迟阈值 / 连不上 / 手动关闭）由运行时持有；账本只拿它做判定，
    // 没有策略时一律不拦（纯账本的老行为）。
    this.policyProvider = typeof options.policyProvider === 'function' ? options.policyProvider : null;
    this.byIdentity = new Map();
    this.nodes = [];
    this.events = [];
    this.persistTimer = null;
    this.load();
  }

  get filePath() {
    if (!this.aiHomeDir) return '';
    return this.path.join(this.aiHomeDir, 'run', 'egress-pool', HEALTH_FILE_NAME);
  }

  load() {
    const file = this.filePath;
    if (!this.fs || !file) return;
    try {
      const doc = JSON.parse(this.fs.readFileSync(file, 'utf8'));
      if (!doc || doc.version !== HEALTH_FILE_VERSION) return;
      Object.entries(doc.nodes || {}).forEach(([identity, stats]) => {
        if (identity && stats && typeof stats === 'object') {
          const normalized = { ...emptyStats(), ...stats };
          if (normalized.cooldownKind === 'ip_blocked') {
            normalized.legacyCooldownKind = 'ip_blocked';
            normalized.legacyCooldownUntil = Number(normalized.cooldownUntil) || 0;
            normalized.cooldownKind = '';
            normalized.cooldownUntil = 0;
          }
          this.byIdentity.set(identity, normalized);
        }
      });
      if (Array.isArray(doc.events)) this.events = doc.events.slice(-this.eventLimit);
    } catch (_error) {
      /* 没有或坏的账本：从空开始 */
    }
  }

  /**
   * 绑定本次启动的节点表（`node-N` → 出口身份 + 展示信息）。
   * @param {Array<{ name: string, node: object }>} entries
   */
  bindNodes(entries) {
    this.nodes = (Array.isArray(entries) ? entries : []).map((entry) => {
      const identity = exitIdentity(entry.node) || `name|${entry.name}`;
      if (!this.byIdentity.has(identity)) this.byIdentity.set(identity, emptyStats());
      const node = entry.node || {};
      // 节点库里的 TCP 建连实测（用户在节点抽屉里测的）。与内核探测是两路数据：
      // 内核探测证明「经这个出口能不能出网」，库里的实测只说明「这台服务器连得上」。
      // 拦截判定优先用可信度更高的那个（见 blockedReason）。
      const libraryLatency = Number(node.latencyMs);
      return {
        name: entry.name,
        nodeId: normalizeString(String(entry.nodeId || node.nodeId || '')) || buildNodeEntityId(node),
        identity,
        label: normalizeString(String(node.name || '')) || entry.name,
        protocol: normalizeString(String(node.protocol || '')),
        server: normalizeString(String(node.server || '')),
        port: Number(node.port) || 0,
        countryCode: normalizeString(String(node.countryCode || '')),
        countryFlag: normalizeString(String(node.countryFlag || '')),
        libraryProbe: Number.isFinite(libraryLatency) && libraryLatency > 0
          ? { ok: true, latencyMs: Math.round(libraryLatency), at: Number(node.lastChecked) || 0, source: 'library' }
          : null
      };
    });
  }

  statsFor(name) {
    const entry = this.nodes.find((node) => node.name === name);
    return entry ? this.byIdentity.get(entry.identity) : null;
  }

  nodeInfo(name) {
    const entry = this.nodes.find((node) => node.name === name);
    return entry ? { ...entry } : null;
  }

  isCooling(name, at = this.now()) {
    const stats = this.statsFor(name);
    return Boolean(stats && stats.cooldownKind !== 'ip_blocked' && stats.cooldownUntil > at);
  }

  /**
   * 这个节点被拦截策略挡住了吗（延迟超阈值 / 探测不通 / 手动关闭）。
   * 返回 { blocked, reason, detail }；没有策略、节点未知、或策略读不出来时一律不拦 ——
   * 策略存储出问题绝不能让整个池没有可用节点。
   */
  blockedReason(name) {
    const entry = this.nodes.find((node) => node.name === name);
    if (!entry || !this.policyProvider) return { blocked: false, reason: '', detail: '' };
    let policy = null;
    try {
      policy = this.policyProvider();
    } catch (_error) {
      return { blocked: false, reason: '', detail: '' };
    }
    if (!policy) return { blocked: false, reason: '', detail: '' };
    const stats = this.byIdentity.get(entry.identity);
    // 两路探测取其一：内核探测（经出口真出网，权威）优先；没有就用节点库里的 TCP 实测。
    // 都没有 = 未知（decideNode 不拦）。这样用户在节点抽屉测出来的慢节点，延迟拦截也能用上。
    const probe = (stats && stats.probe) || entry.libraryProbe || null;
    const verdict = decideNode({ policy, identity: entry.identity, probe });
    return { blocked: verdict.status === 'blocked', reason: verdict.reason, detail: verdict.detail };
  }

  pushEvent(event) {
    this.events.push({ at: this.now(), ...event });
    if (this.events.length > this.eventLimit) this.events.splice(0, this.events.length - this.eventLimit);
    this.schedulePersist();
  }

  /** 一次请求经 name 出口成功。 */
  recordSuccess(name, context = {}) {
    const stats = this.statsFor(name);
    if (!stats) return;
    const at = this.now();
    stats.uses += 1;
    stats.successes += 1;
    stats.consecutiveFailures = 0;
    stats.lastUsedAt = at;
    stats.lastSuccessAt = at;
    this.noteAccount(stats, context.accountRef, at);
    // 成功即证明该出口可用：网络类冷却直接解除（额度类不解除 —— 额度是按模型计的，
    // 另一个模型成功不代表这个模型的额度回来了，交给冷却到期）。
    if (stats.cooldownUntil > at && stats.cooldownKind === 'network') {
      stats.cooldownUntil = 0;
      stats.cooldownKind = '';
      this.pushEvent({ type: 'recovered', node: name, reason: 'request_succeeded' });
    }
    this.schedulePersist();
  }

  /** 一次请求经 name 出口因出口原因失败；返回该节点的冷却时长（ms）。 */
  recordFailure(name, kind, context = {}) {
    // Regional/IP rejection belongs to scoped account-upstream evidence. It
    // must never mutate the shared NodeHealth ledger, even for a live process.
    if (kind === 'ip_blocked') return 0;
    const stats = this.statsFor(name);
    const baseMs = FAILURE_KINDS[kind];
    if (!stats || !baseMs) return 0;
    const at = this.now();
    stats.uses += 1;
    stats.failures += 1;
    stats.consecutiveFailures += 1;
    stats.failuresByKind[kind] = (stats.failuresByKind[kind] || 0) + 1;
    stats.lastUsedAt = at;
    stats.lastFailureAt = at;
    stats.lastFailureKind = kind;
    this.noteAccount(stats, context.accountRef, at);
    // 连续失败指数退避（每多一次 ×2），封顶；上游给了明确的恢复时刻就用它（同样封顶）。
    const hinted = Number(context.retryAfterMs) > 0 ? Number(context.retryAfterMs) : 0;
    const cooldownMs = FIXED_COOLDOWN_KINDS.has(kind)
      ? baseMs
      : Math.min(EGRESS_POOL_NODE_MAX_COOLDOWN_MS, Math.max(baseMs * (2 ** Math.min(6, stats.consecutiveFailures - 1)), hinted));
    stats.cooldownUntil = Math.max(stats.cooldownUntil, at + cooldownMs);
    stats.cooldownKind = kind;
    this.pushEvent({
      type: 'cooldown',
      node: name,
      kind,
      cooldownMs,
      accountRef: normalizeString(context.accountRef),
      model: normalizeString(context.model)
    });
    return cooldownMs;
  }

  noteAccount(stats, accountRef, at) {
    const ref = normalizeString(accountRef);
    if (!ref) return;
    const current = stats.accounts[ref] || { uses: 0, lastUsedAt: 0 };
    stats.accounts[ref] = { uses: current.uses + 1, lastUsedAt: at };
    const refs = Object.keys(stats.accounts);
    if (refs.length > MAX_ACCOUNTS_PER_NODE) {
      refs.sort((a, b) => stats.accounts[a].lastUsedAt - stats.accounts[b].lastUsedAt)
        .slice(0, refs.length - MAX_ACCOUNTS_PER_NODE)
        .forEach((oldest) => { delete stats.accounts[oldest]; });
    }
  }

  recordSwitch(fromNode, toNode, reason) {
    this.pushEvent({ type: 'switch', from: normalizeString(fromNode), node: toNode, reason: normalizeString(reason) });
  }

  /**
   * 选下一个节点：从 fromIndex 之后按顺序找第一个**不在冷却、也没被策略拦截**的节点；
   * 全都不行时选最早解冻的（让请求仍有一个最可能恢复的出口可试，而不是直接失败）。返回下标；无节点返回 -1。
   *
   * options.allowed（Set<name>）：只在这些节点里选（车道的节点范围 ∩ 地区判定允许）；空集合 = 无可选 → -1。
   * options.avoid（Set<name>）：尽量不选（同上游其它独占车道正在用的节点）；没得选时放宽。
   */
  pickNext(fromIndex, options = {}) {
    const count = this.nodes.length;
    if (count === 0) return -1;
    const allowed = options.allowed instanceof Set ? options.allowed : null;
    const avoid = options.avoid instanceof Set ? options.avoid : new Set();
    if (allowed && allowed.size === 0) return -1;
    const at = this.now();
    const start = Number.isInteger(fromIndex) ? fromIndex : -1;
    const ordered = [];
    for (let step = 1; step <= count; step += 1) {
      const index = (((start + step) % count) + count) % count;
      if (!allowed || allowed.has(this.nodes[index].name)) ordered.push(index);
    }
    if (ordered.length === 0) return -1;
    // 拦截策略（延迟阈值 / 连不上 / 手动关闭）与冷却一样是硬跳过：被拦的节点不参与轮换。
    const usable = (index) => !this.isCooling(this.nodes[index].name, at)
      && !this.blockedReason(this.nodes[index].name).blocked;
    const free = ordered.filter(usable);
    const preferred = free.find((index) => !avoid.has(this.nodes[index].name));
    if (preferred !== undefined) return preferred;
    if (free.length) return free[0];
    // 全被冷却 / 拦截：优先挑被拦截（非冷却）的 —— 冷却中的节点刚失败过，拦截的只是慢或用户关掉的。
    const blockedButNotCooling = ordered.filter((index) => !this.isCooling(this.nodes[index].name, at));
    if (blockedButNotCooling.length) return blockedButNotCooling[0];
    let best = ordered[0];
    let bestUntil = Infinity;
    ordered.forEach((index) => {
      const until = (this.byIdentity.get(this.nodes[index].identity) || {}).cooldownUntil || 0;
      if (until < bestUntil) { bestUntil = until; best = index; }
    });
    return best;
  }

  /** 当前可参与轮换的节点数（没冷却、没被拦截）。 */
  usableCount(at = this.now()) {
    return this.nodes.filter((node) => !this.isCooling(node.name, at) && !this.blockedReason(node.name).blocked).length;
  }

  /** 节点名 → 出口身份（地区实测按身份记，跨重启稳定）。 */
  identityOf(name) {
    const entry = this.nodes.find((node) => node.name === name);
    return entry ? entry.identity : '';
  }

  /** 节点的真实出口位置（egress-geo 查询结果）；未查过返回 null。 */
  geoOf(name) {
    const stats = this.statsFor(name);
    return stats && stats.geo ? stats.geo : null;
  }

  recordGeo(name, geo) {
    const stats = this.statsFor(name);
    if (!stats || !geo || !geo.country) return;
    stats.geo = {
      country: normalizeString(geo.country).toUpperCase(),
      region: normalizeString(geo.region),
      city: normalizeString(geo.city),
      asn: normalizeString(geo.asn),
      org: normalizeString(geo.org),
      ip: normalizeString(geo.ip),
      // 数据来源（本地库 id 链，如 'local:dbip-city+geolite2-asn'）：诊断「这条位置怎么来的」用。
      source: normalizeString(geo.source),
      at: Number(geo.at) || this.now()
    };
    this.schedulePersist();
  }

  /**
   * 该探测的节点：网络类冷却中的节点（探测成功可提前恢复）+ 从未探测过的节点
   * + **被拦截策略挡住的节点**（延迟恢复正常 / 用户重新放行后才能回到轮换）。
   */
  dueForProbe(limit = 8) {
    const at = this.now();
    return this.nodes
      .filter((node) => {
        const stats = this.byIdentity.get(node.identity);
        if (!stats) return false;
        if (stats.cooldownUntil > at && stats.cooldownKind === 'network') return true;
        if (this.blockedReason(node.name).blocked) return true;
        return !stats.probe;
      })
      .slice(0, limit)
      .map((node) => node.name);
  }

  recordProbe(name, result = {}) {
    const stats = this.statsFor(name);
    if (!stats) return;
    const at = this.now();
    const ok = result.ok === true;
    stats.probe = { ok, latencyMs: ok ? Number(result.latencyMs) || 0 : 0, at, error: ok ? '' : normalizeString(result.error) };
    if (ok && stats.cooldownUntil > at && stats.cooldownKind === 'network') {
      stats.cooldownUntil = 0;
      stats.cooldownKind = '';
      stats.consecutiveFailures = 0;
      this.pushEvent({ type: 'recovered', node: name, reason: 'probe_ok', latencyMs: stats.probe.latencyMs });
    } else if (!ok && result.reportFailure) {
      this.pushEvent({ type: 'probe_failed', node: name, reason: stats.probe.error });
    }
    this.schedulePersist();
  }

  /** 人工解除冷却（WebUI「解除冷却」）。 */
  clearCooldown(name) {
    const stats = this.statsFor(name);
    if (!stats) return false;
    stats.cooldownUntil = 0;
    stats.cooldownKind = '';
    stats.consecutiveFailures = 0;
    this.pushEvent({ type: 'recovered', node: name, reason: 'manual' });
    return true;
  }

  snapshot() {
    const at = this.now();
    // 按 name 建一次索引：下面每个节点都要取自己的 libraryProbe，用 find 会退化成
  // O(n²)（节点上万时单次快照几百毫秒，且随节点数平方增长）。
    const nodeByName = new Map(this.nodes.map((node) => [node.name, node]));
    return {
      nodes: this.nodes.map((node) => {
        const stats = this.byIdentity.get(node.identity) || emptyStats();
        const cooling = stats.cooldownUntil > at;
        const blocked = this.blockedReason(node.name);
        return {
          ...node,
          uses: stats.uses,
          successes: stats.successes,
          failures: stats.failures,
          failuresByKind: { ...stats.failuresByKind },
          consecutiveFailures: stats.consecutiveFailures,
          lastUsedAt: stats.lastUsedAt,
          lastSuccessAt: stats.lastSuccessAt,
          lastFailureAt: stats.lastFailureAt,
          lastFailureKind: stats.lastFailureKind,
          cooling,
          cooldownUntil: cooling ? stats.cooldownUntil : 0,
          cooldownKind: cooling ? stats.cooldownKind : '',
          cooldownRemainingMs: cooling ? stats.cooldownUntil - at : 0,
          // 拦截策略的结论（与 pickNext 同一份判定）：界面据此显示「已拦截 · 原因」并给手动开关。
          blocked: blocked.blocked,
          blockedReason: blocked.blocked ? blocked.reason : '',
          blockedDetail: blocked.blocked ? blocked.detail : '',
          // 展示用的探测值：内核探测优先，退回节点库实测（带 source，界面能说明来源）。
          probe: stats.probe ? { ...stats.probe, source: 'core' }
            : (nodeByName.get(node.name) || {}).libraryProbe || null,
          geo: stats.geo ? { ...stats.geo } : null,
          accounts: Object.entries(stats.accounts)
            .map(([accountRef, entry]) => ({ accountRef, uses: entry.uses, lastUsedAt: entry.lastUsedAt }))
            .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        };
      }),
      events: this.events.slice().reverse()
    };
  }

  schedulePersist() {
    if (!this.fs || !this.filePath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
    if (this.persistTimer && typeof this.persistTimer.unref === 'function') this.persistTimer.unref();
  }

  persist() {
    const file = this.filePath;
    if (!this.fs || !file) return false;
    try {
      const dir = this.path.dirname(file);
      this.fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const doc = {
        version: HEALTH_FILE_VERSION,
        nodes: Object.fromEntries(this.byIdentity.entries()),
        events: this.events
      };
      const tmp = `${file}.${process.pid}.tmp`;
      this.fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
      this.fs.renameSync(tmp, file);
      return true;
    } catch (_error) {
      return false;
    }
  }

  flush() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    return this.persist();
  }
}

module.exports = {
  EgressPoolNodeHealth,
  FAILURE_KINDS,
  HEALTH_FILE_NAME,
  exitIdentity
};
