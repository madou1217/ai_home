'use strict';

// 出口池后台维护：让地区判定的依据（节点位置、出口 × 上游实测）保持新鲜，并在依据变化后重新规划车道。
//
// 每一轮（server 定时器驱动，见 server.js）：
//   1. 位置：先补「挂起车道」范围里缺位置的节点（这些车道正因位置未知而没有出口），再补其余节点；
//   2. 实测：对有池绑定的上游，探测其范围内「没有实测 / 实测已过期」的节点（被动探测，不带凭据）；
//   3. 有任何新结论 → planner.reconcile()。
// 所有步骤都经探测入站串行执行，不切换任何车道或 GLOBAL，不影响在途请求。永不抛。

const nodeFs = require('node:fs');

const { DEFAULT_EVIDENCE_TTL_MS, nodeExitKey, readUpstreamEvidence } = require('./egress-region-policy');
const { probeUpstreamViaNode } = require('./egress-upstream-probe');

const GEO_PER_TICK = 12;
const PROBES_PER_TICK = 6;
const RECONCILE_EVERY = 4;

function createEgressPoolMaintenance(deps = {}) {
  const fs = deps.fs || nodeFs;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const planner = deps.planner;
  const getService = typeof deps.getService === 'function' ? deps.getService : () => null;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};
  let running = null;

  function runtime() {
    const service = getService();
    return service && service.ready ? service.runtime : null;
  }

  async function refreshGeos(rt, computed, limit) {
    const pendingAccounts = [...computed.accounts.values()].filter((info) => info.pending > 0);
    const geoMissing = (node) => !(node.geo && node.geo.country);
    // 挂起车道范围内的节点优先：它们查到位置后车道才有出口。
    const priority = new Set();
    if (pendingAccounts.length) {
      computed.nodes.filter(geoMissing).forEach((node) => priority.add(node.name));
    }
    const order = [...priority, ...computed.nodes.filter((node) => !priority.has(node.name)).map((node) => node.name)];
    const due = order.filter((name) => {
      const geo = rt.health.geoOf(name);
      return !geo || Number(geo.at) + rt.geoTtlMs <= now();
    }).slice(0, limit);
    let changed = 0;
    for (const name of due) {
      if (!rt.started) break;
      // eslint-disable-next-line no-await-in-loop
      const result = await rt.lookupNodeGeo(name);
      if (result && result.ok && !result.cached) {
        changed += 1;
        if (changed % RECONCILE_EVERY === 0) planner.reconcile();
      }
    }
    return changed;
  }

  async function refreshEvidence(rt, computed, limit) {
    const byUpstream = new Map();
    computed.plan.forEach((lane) => {
      if (!lane.upstream || lane.upstream === 'unknown') return;
      const names = byUpstream.get(lane.upstream) || new Set();
      // 探测范围 = 车道范围内的全部节点（含被提示拒绝的：实测才能推翻 / 坐实提示）。
      (lane.scopeNames || lane.allowed).forEach((name) => names.add(name));
      byUpstream.set(lane.upstream, names);
    });
    let probed = 0;
    for (const [upstreamId, names] of byUpstream) {
      if (probed >= limit) break;
      const accountInfo = [...computed.accounts.values()].find((info) => info.upstream === upstreamId);
      const context = accountInfo ? planner.upstreamContextById(upstreamId) : null;
      if (!context) continue;
      const ttl = context.ttlMs || DEFAULT_EVIDENCE_TTL_MS;
      const evidence = readUpstreamEvidence(fs, aiHomeDir, upstreamId);
      const due = [...names].filter((name) => {
        const entry = evidence[nodeExitKey(rt.health.identityOf(name))];
        return !entry || Number(entry.at) + ttl <= now();
      });
      for (const name of due) {
        if (probed >= limit || !rt.started) break;
        // eslint-disable-next-line no-await-in-loop
        await probeUpstreamViaNode({ runtime: rt, upstream: context.upstream, node: name, fs, aiHomeDir });
        probed += 1;
      }
    }
    return probed;
  }

  /** 跑一轮维护。options.geoLimit / probeLimit 覆盖单轮数量（池刚就绪时一次性补全位置）。 */
  function tick(options = {}) {
    if (running) return running;
    running = (async () => {
      const rt = runtime();
      if (!rt || !planner) return { geo: 0, probes: 0 };
      try {
        const computed = planner.computePlan();
        if (computed.plan.length === 0) return { geo: 0, probes: 0 };
        const geo = await refreshGeos(rt, computed, options.geoLimit || GEO_PER_TICK);
        const probes = await refreshEvidence(rt, planner.computePlan(), options.probeLimit || PROBES_PER_TICK);
        if (geo || probes) planner.reconcile();
        return { geo, probes };
      } catch (error) {
        logger(`egress-pool maintenance failed: ${String((error && error.message) || error)}`);
        return { geo: 0, probes: 0, error: String((error && error.message) || error) };
      }
    })().finally(() => { running = null; });
    return running;
  }

  return { tick, get running() { return Boolean(running); } };
}

module.exports = { createEgressPoolMaintenance };
