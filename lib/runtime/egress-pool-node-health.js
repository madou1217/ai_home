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
  EGRESS_POOL_NODE_IP_BLOCKED_COOLDOWN_MS,
  EGRESS_POOL_NODE_MAX_COOLDOWN_MS,
  EGRESS_POOL_EVENT_HISTORY
} = require('../cli/config/constants');

const HEALTH_FILE_NAME = 'node-health.json';
const HEALTH_FILE_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 2000;
const MAX_ACCOUNTS_PER_NODE = 20;

// 失败类别 → 冷却基准。类别名同时出现在事件流与 UI 上。
const FAILURE_KINDS = Object.freeze({
  free_limit: EGRESS_POOL_NODE_FREE_LIMIT_COOLDOWN_MS,
  gate: EGRESS_POOL_NODE_GATE_COOLDOWN_MS,
  network: EGRESS_POOL_NODE_NETWORK_COOLDOWN_MS,
  ip_blocked: EGRESS_POOL_NODE_IP_BLOCKED_COOLDOWN_MS
});
// 固定时长、不退避、不受 30 分钟上限约束的类别：出口 IP 被拉黑不会几分钟内恢复。
const FIXED_COOLDOWN_KINDS = new Set(['ip_blocked']);

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
        if (identity && stats && typeof stats === 'object') this.byIdentity.set(identity, { ...emptyStats(), ...stats });
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
      return {
        name: entry.name,
        identity,
        label: normalizeString(String(node.name || '')) || entry.name,
        protocol: normalizeString(String(node.protocol || '')),
        server: normalizeString(String(node.server || '')),
        port: Number(node.port) || 0,
        countryCode: normalizeString(String(node.countryCode || '')),
        countryFlag: normalizeString(String(node.countryFlag || ''))
      };
    });
  }

  statsFor(name) {
    const entry = this.nodes.find((node) => node.name === name);
    return entry ? this.byIdentity.get(entry.identity) : null;
  }

  isCooling(name, at = this.now()) {
    const stats = this.statsFor(name);
    return Boolean(stats && stats.cooldownUntil > at);
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
   * 选下一个节点：从 fromIndex 之后按顺序找第一个**不在冷却**的节点；全部冷却时选最早解冻的
   * （让请求仍有一个最可能恢复的出口可试，而不是直接失败）。返回下标；无节点返回 -1。
   */
  pickNext(fromIndex) {
    const count = this.nodes.length;
    if (count === 0) return -1;
    const at = this.now();
    for (let step = 1; step <= count; step += 1) {
      const index = (fromIndex + step) % count;
      if (!this.isCooling(this.nodes[index].name, at)) return index;
    }
    let best = (fromIndex + 1) % count;
    let bestUntil = Infinity;
    this.nodes.forEach((node, index) => {
      const until = (this.byIdentity.get(node.identity) || {}).cooldownUntil || 0;
      if (until < bestUntil) { bestUntil = until; best = index; }
    });
    return best;
  }

  /** 该探测的节点：网络类冷却中的节点（探测成功可提前恢复）+ 从未探测过的节点。 */
  dueForProbe(limit = 8) {
    const at = this.now();
    return this.nodes
      .filter((node) => {
        const stats = this.byIdentity.get(node.identity);
        if (!stats) return false;
        if (stats.cooldownUntil > at && stats.cooldownKind === 'network') return true;
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
    return {
      nodes: this.nodes.map((node) => {
        const stats = this.byIdentity.get(node.identity) || emptyStats();
        const cooling = stats.cooldownUntil > at;
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
          probe: stats.probe ? { ...stats.probe } : null,
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
