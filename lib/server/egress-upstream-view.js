'use strict';

// WebUI「上游」视图：每个上游（api.anthropic.com / 中转主机 …）的账号、地区规则、预置提示、
// 实测矩阵（节点 × 判定）与当前网络判定。判定全部复用规划器 / 网络守卫同一套函数，
// 界面看到的结论与车道 / 守卫实际执行的结论一致。只读，不发网络请求。

const nodeFs = require('node:fs');

const { listAccountEgressBindings } = require('../account/zcode-egress-binding-store');
const { describeGeo } = require('../runtime/egress-geo');
const { evaluateNetworkExit, peekExitGeo } = require('../runtime/egress-network-guard');
const { DEFAULT_EVIDENCE_TTL_MS } = require('./egress-region-policy');
const { listUpstreams, readUpstreamDecisionContext } = require('./egress-upstream');
const { resolveProxyConfig } = require('./http-utils-utils');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function accountLabel(account) {
  const id = account && (account.cliAccountId || account.id);
  const name = account && (account.email || account.displayName || account.name || account.label);
  return [id ? `#${id}` : '', normalizeString(name)].filter(Boolean).join(' ');
}

function bindingSummary(binding) {
  if (!binding) return null;
  return {
    mode: binding.mode,
    retired: Boolean(binding.retired),
    ...(binding.mode === 'pool' ? { scope: binding.scope, strategy: binding.strategy } : {}),
    ...(binding.mode === 'url' ? { proxyUrl: redactProxy(binding.proxyUrl) } : {})
  };
}

function redactProxy(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }
    return url.toString().replace(/\/$/, '');
  } catch (_error) {
    return '';
  }
}

/** 非出口池账号的实际出口：账号代理 / 全局（或环境）代理 / 直连；system 模式无法在这里同步判定。 */
function networkExitFor(binding, upstream, serverOptions) {
  if (binding && binding.mode === 'pool') return null;
  if (binding && binding.mode === 'system') return { kind: 'system', proxyUrl: '' };
  if (binding && binding.mode === 'url') return { kind: 'proxy', proxyUrl: normalizeString(binding.proxyUrl) };
  if (binding && binding.mode === 'tun') return { kind: 'direct', proxyUrl: '' };
  const proxyUrl = resolveProxyConfig(upstream.baseUrl, serverOptions || {}).url;
  return { kind: proxyUrl ? 'proxy' : 'direct', proxyUrl };
}

/**
 * @param {object} input { fs, aiHomeDir, pools, serverOptions, planner, service, accountRef? }
 */
function buildEgressUpstreamView(input = {}) {
  const fs = input.fs || nodeFs;
  const aiHomeDir = normalizeString(input.aiHomeDir);
  const now = Date.now();
  const planner = input.planner;
  const service = input.service;
  const runtime = service && service.ready ? service.runtime : null;
  const bindings = new Map();
  try {
    listAccountEgressBindings(fs, aiHomeDir).forEach((entry) => bindings.set(entry.accountRef, entry.binding));
  } catch (_error) { /* 没有绑定 */ }
  const accountsByRef = new Map();
  Object.values(input.pools || {}).forEach((pool) => (Array.isArray(pool) ? pool : []).forEach((account) => {
    if (account && account.accountRef) accountsByRef.set(account.accountRef, account);
  }));
  const computed = planner ? planner.computePlan() : { accounts: new Map(), plan: [], nodes: [] };
  const nodes = computed.nodes || [];
  let upstreams = listUpstreams(input.serverOptions || {}, input.pools || {});
  const onlyAccount = normalizeString(input.accountRef);
  if (onlyAccount) upstreams = upstreams.filter((upstream) => upstream.accounts.includes(onlyAccount));

  const view = upstreams.map((upstream) => {
    const context = readUpstreamDecisionContext(fs, aiHomeDir, upstream);
    const ttlMs = context.ttlMs || DEFAULT_EVIDENCE_TTL_MS;
    const verdicts = planner ? planner.evaluateNodesForUpstream({ ...context, nodes, now }) : new Map();
    const nodeRows = nodes.map((node) => {
      let verdict = verdicts.get(node.name) || { status: 'unknown', source: 'none' };
      // 位置已知、没有任何规则 / 提示 / 实测否定它：界面上算「允许（未实测）」，与车道放行一致。
      if (verdict.status === 'unknown' && !verdict.geoPending && node.geo && node.geo.country) {
        verdict = { ...verdict, status: 'allowed', source: 'geo', soft: true, detail: '位置未命中拒绝规则（未实测）' };
      }
      const evidence = context.evidence[`node:${node.identity}`] || null;
      return {
        name: node.name,
        identity: node.identity,
        label: node.label,
        geo: node.geo || null,
        geoText: describeGeo(node.geo),
        groups: [...(node.groups || [])],
        verdict: {
          status: verdict.geoPending ? 'pending' : verdict.status,
          source: verdict.source,
          detail: verdict.geoPending ? '等待查询出口位置' : verdict.detail,
          soft: Boolean(verdict.soft),
          ruleId: verdict.ruleId || ''
        },
        evidence: evidence ? { ...evidence, expired: Number(evidence.at) + ttlMs <= now } : null
      };
    });
    const summary = { allowed: 0, denied: 0, pending: 0, unknown: 0 };
    nodeRows.forEach((row) => { summary[row.verdict.status] = (summary[row.verdict.status] || 0) + 1; });
    const accounts = upstream.accounts.map((accountRef) => {
      const account = accountsByRef.get(accountRef) || { accountRef };
      const binding = bindings.get(accountRef) || null;
      const planInfo = computed.accounts.get(accountRef) || null;
      const lane = runtime && typeof runtime.laneOf === 'function' ? runtime.laneOf(accountRef) : null;
      const exit = networkExitFor(binding, upstream, input.serverOptions);
      let network = null;
      if (exit && exit.kind !== 'system') {
        const geo = peekExitGeo({ fs, aiHomeDir, proxyUrl: exit.proxyUrl });
        const verdict = evaluateNetworkExit(context, geo);
        network = {
          exit: exit.kind,
          proxyUrl: redactProxy(exit.proxyUrl),
          geo: geo ? geo.geo : null,
          geoText: geo ? describeGeo(geo.geo) : '',
          stale: Boolean(geo && geo.stale),
          status: verdict ? verdict.status : 'allowed',
          source: verdict ? verdict.source : 'none',
          detail: verdict ? verdict.detail : '该上游没有地区规则'
        };
      } else if (exit) {
        network = { exit: 'system', status: 'unknown', source: 'none', detail: '系统代理的出口位置在请求时判定' };
      }
      return {
        accountRef,
        provider: normalizeString(account.provider),
        label: accountLabel(account),
        egress: bindingSummary(binding),
        lane: lane ? {
          activeNode: lane.active,
          activeLabel: (nodes.find((node) => node.name === lane.active) || {}).label || '',
          blocked: lane.blocked || '',
          strategy: lane.strategy,
          allowedCount: planInfo ? planInfo.allowed : 0,
          scopeCount: planInfo ? planInfo.inScope : 0
        } : (planInfo ? { activeNode: '', blocked: planInfo.blockedReason || 'egress_pool_lane_not_ready', allowedCount: planInfo.allowed, scopeCount: planInfo.inScope } : null),
        network
      };
    });
    return {
      id: upstream.id,
      host: upstream.host,
      providers: upstream.providers,
      official: upstream.official,
      policy: context.policy,
      effectiveTtlMs: ttlMs,
      hints: context.hints,
      accounts,
      unboundCount: accounts.filter((account) => !account.egress).length,
      deniedAccounts: accounts.filter((account) => account.network && account.network.status === 'denied').length,
      nodes: nodeRows,
      summary,
      evidence: Object.entries(context.evidence).map(([exitKey, entry]) => ({
        exitKey,
        ...entry,
        expired: Number(entry.at) + ttlMs <= now,
        node: (nodeRows.find((row) => `node:${row.identity}` === exitKey) || {}).label || ''
      })).sort((a, b) => b.at - a.at)
    };
  });

  return {
    upstreams: view,
    groups: planner ? planner.catalogGroups().map((group) => ({ id: group.id, name: group.name, profileName: group.profileName, size: group.identities.length })) : [],
    pool: {
      ready: Boolean(runtime),
      nodeCount: nodes.length,
      geoKnown: nodes.filter((node) => node.geo && node.geo.country).length,
      lanes: runtime ? runtime.describeLanes() : [],
      laneOverflow: runtime ? runtime.laneOverflow : []
    },
    network: (() => {
      const direct = peekExitGeo({ fs, aiHomeDir, proxyUrl: '' });
      return direct ? { direct: { geo: direct.geo, geoText: describeGeo(direct.geo), at: direct.at, stale: direct.stale } } : { direct: null };
    })(),
    serverTime: now
  };
}

module.exports = {
  buildEgressUpstreamView,
  redactProxy
};
