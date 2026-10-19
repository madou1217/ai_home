'use strict';

// 账号 → 上游：请求实际打到的接口主机（地区策略的作用对象）。
//
// 唯一事实来源是网关自己的上游解析 resolveProviderUpstream（与 upstream-endpoints-attempt
// 同一个函数）；解析不出时退回该 provider 登记的第一个官方主机（OFFICIAL_UPSTREAM_HOSTS）。
//   - OAuth / 官方地址账号 → 官方上游（claude 的全部 OAuth 账号 = 一个 api.anthropic.com）；
//   - API Key + 自定义 baseUrl → baseUrl 的主机（每个中转是独立上游）。
// 官方上游继承 provider 描述符声明的地区提示与拒绝特征；第三方上游不继承。

const { resolveProviderUpstream } = require('./upstream-endpoints-path');
const {
  isOfficialUpstreamHost,
  listOfficialUpstreamHosts,
  readUpstreamHost
} = require('../account/official-upstream-endpoint');
const {
  normalizeRule,
  readUpstreamEvidence,
  readUpstreamPolicy
} = require('./egress-region-policy');

// 任何上游都适用的通用地区拒绝特征（HTTP 451 由调用方按状态码判定）。
const GENERIC_DENY_SIGNATURES = Object.freeze([
  'unavailable for legal reasons',
  'not available in your region',
  'not available in your country'
]);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function regionPolicyOf(provider) {
  try {
    // 门面按需加载：描述符会拉起各 provider 的模块，避免初始化时成环。
    const egress = require('../providers').getProviderCapability(provider, 'egress');
    return egress && egress.regionPolicy ? egress.regionPolicy : null;
  } catch (_error) {
    return null;
  }
}

/**
 * @returns {{ id: string, host: string, baseUrl: string, provider: string, official: boolean } | null}
 */
function resolveAccountUpstream(options, account) {
  const provider = normalizeString(account && account.provider).toLowerCase();
  if (!provider) return null;
  let baseUrl = '';
  try {
    baseUrl = normalizeString(resolveProviderUpstream(options || {}, provider, account || {}));
  } catch (_error) {
    baseUrl = '';
  }
  let host = readUpstreamHost(baseUrl);
  if (!host) host = listOfficialUpstreamHosts(provider)[0] || '';
  if (!host) return null;
  const apiKeyMode = Boolean(account && (account.apiKeyMode || account.authType === 'api-key'));
  return {
    id: host,
    host,
    baseUrl: baseUrl || `https://${host}`,
    provider,
    // OAuth 登录态账号打的一定是厂商自己的端点（codex OAuth 是 chatgpt.com，不在 API 官方主机表里）。
    official: !apiKeyMode || isOfficialUpstreamHost(provider, host) || !readUpstreamHost(baseUrl)
  };
}

/** 上游的预置提示（只有官方上游有），已规范化成规则形状并带出处。 */
function upstreamHints(upstream) {
  if (!upstream || !upstream.official) return [];
  const policy = regionPolicyOf(upstream.provider);
  if (!policy) return [];
  return policy.hints.map((hint, index) => {
    const rule = normalizeRule({ ...hint, id: `hint_${index + 1}` }, index);
    return rule ? { ...rule, source: hint.source, asOf: hint.asOf, note: hint.note } : null;
  }).filter(Boolean);
}

/** 上游的地区拒绝特征：通用 + 官方上游声明的。 */
function upstreamDenySignatures(upstream) {
  const declared = upstream && upstream.official ? ((regionPolicyOf(upstream.provider) || {}).denySignatures || []) : [];
  return [...new Set([...GENERIC_DENY_SIGNATURES, ...declared])];
}

/**
 * 一次上游响应 / 错误是否表示「这个出口所在地区被该上游拒绝」。
 * statusCode 451 直接判定；否则在响应文本里找拒绝特征。
 */
function isRegionDenied(upstream, { statusCode, text } = {}) {
  if (Number(statusCode) === 451) return 'http_451';
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return '';
  return upstreamDenySignatures(upstream).find((signature) => haystack.includes(signature)) || '';
}

/**
 * 从运行池列出所有上游（与账号）：[{ id, host, provider, official, accounts: [accountRef...] }]。
 */
function listUpstreams(options, pools) {
  const byId = new Map();
  Object.values(pools && typeof pools === 'object' ? pools : {}).forEach((pool) => {
    (Array.isArray(pool) ? pool : []).forEach((account) => {
      const upstream = resolveAccountUpstream(options, account);
      if (!upstream) return;
      const entry = byId.get(upstream.id) || { ...upstream, providers: new Set(), accounts: [] };
      entry.providers.add(upstream.provider);
      if (account.accountRef && !entry.accounts.includes(account.accountRef)) entry.accounts.push(account.accountRef);
      // 同一主机只要有一个账号是官方形态就算官方（提示与特征才会生效）。
      entry.official = entry.official || upstream.official;
      byId.set(upstream.id, entry);
    });
  });
  return [...byId.values()].map((entry) => ({ ...entry, providers: [...entry.providers] }))
    .sort((a, b) => b.accounts.length - a.accounts.length || a.id.localeCompare(b.id));
}

/**
 * 上游的判定上下文（规划器、网络守卫、WebUI 共用，保证三处结论一致）：
 * { upstream, policy, evidence, hints, ttlMs }。ttlMs = 上游覆盖值 || server config 全局值 || 0（默认 7 天）。
 */
function readUpstreamDecisionContext(fs, aiHomeDir, upstream) {
  if (!upstream) return null;
  const policy = readUpstreamPolicy(fs, aiHomeDir, upstream.id);
  let globalTtl = 0;
  try {
    // eslint-disable-next-line global-require
    globalTtl = Number(require('./server-config-store').readServerConfig({ fs, aiHomeDir }).egressEvidenceTtlMs) || 0;
  } catch (_error) {
    globalTtl = 0;
  }
  return {
    upstream,
    policy,
    evidence: readUpstreamEvidence(fs, aiHomeDir, upstream.id),
    hints: upstreamHints(upstream),
    ttlMs: policy.evidenceTtlMs || globalTtl
  };
}

module.exports = {
  GENERIC_DENY_SIGNATURES,
  readUpstreamDecisionContext,
  isRegionDenied,
  listUpstreams,
  resolveAccountUpstream,
  upstreamDenySignatures,
  upstreamHints
};
