'use strict';

// 上游地区策略：某个出口能不能用来访问某个上游（例如 api.anthropic.com）。
//
// 设计（docs/plans/2026-10-19-account-egress-upstream-policy.md）：
//   - 策略挂在**上游**上，同一上游的所有账号共用一份（N 个 claude OAuth 账号只配一次）；
//   - 判定三层：用户规则 > 实测（带有效期）> 预置提示（只是提示，可被实测推翻）> 未知（允许）；
//   - 规则匹配出口的**真实位置**（egress-geo）：国家 / 省州 / 城市 / ASN / CIDR / 节点 / 自建分组；
//   - 实测按「出口 × 上游」记：exitKey = node:<出口身份> | ip:<出口 IP>；「被拒」到期后台重测。
//
// 本模块：规则/证据的形状与存储（app_kv），以及纯函数判定。上游的推导与提示见 egress-upstream。

const {
  deleteJsonValue,
  readJsonValue,
  writeJsonValue
} = require('./app-state-store');
const {
  SCOPES,
  classifyLegacyEvidence,
  normalizeEvidenceRecord
} = require('./egress-evidence-scope');

const POLICY_KEY_PREFIX = 'egress:upstream-policy:';
const EVIDENCE_KEY_PREFIX = 'egress:upstream-evidence:';
const DEFAULT_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RULES = 100;
const MAX_EVIDENCE_PER_UPSTREAM = 2000;

const RULE_EFFECTS = Object.freeze(['deny', 'allow']);
const MATCH_FIELDS = Object.freeze(['country', 'region', 'city', 'asn', 'cidr', 'nodes', 'groups']);
// 实测状态：ok / blocked 是定论；reachable = 不带凭据能连通但没验证到认证阶段（弱于提示）。
const EVIDENCE_STATUSES = Object.freeze(['ok', 'blocked', 'reachable']);
const EVIDENCE_SOURCES = Object.freeze(['probe', 'traffic', 'credentialed', 'manual']);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeUpstreamId(value) {
  return normalizeString(value).toLowerCase().replace(/[^a-z0-9.:-]/g, '');
}

function list(value, transform = (item) => item) {
  const items = Array.isArray(value) ? value : (value === undefined || value === null || value === '' ? [] : [value]);
  return [...new Set(items.map((item) => transform(normalizeString(String(item)))).filter(Boolean))];
}

// ── IPv4 CIDR ─────────────────────────────────────────────────────────────

function ipv4ToInt(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = (value * 256) + Number(part);
  }
  return value;
}

function parseCidr(text) {
  const [ip, bitsText] = String(text || '').split('/');
  const base = ipv4ToInt(ip);
  const bits = bitsText === undefined ? 32 : Number(bitsText);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const start = Math.floor(base / size) * size;
  return { start, end: start + size - 1 };
}

function cidrContains(cidr, ip) {
  const range = parseCidr(cidr);
  const value = ipv4ToInt(ip);
  return Boolean(range && value !== null && value >= range.start && value <= range.end);
}

// ── 规则 ───────────────────────────────────────────────────────────────────

function normalizeRule(raw, index = 0) {
  const rule = raw && typeof raw === 'object' ? raw : {};
  const effect = RULE_EFFECTS.includes(rule.effect) ? rule.effect : 'deny';
  const source = rule.match && typeof rule.match === 'object' ? rule.match : {};
  const match = {
    country: list(source.country, (value) => value.toUpperCase()).filter((value) => /^[A-Z]{2}$/.test(value)),
    region: list(source.region, (value) => value.toLowerCase()),
    city: list(source.city, (value) => value.toLowerCase()),
    asn: list(source.asn, (value) => {
      const upper = value.toUpperCase();
      return /^AS\d+$/.test(upper) ? upper : (/^\d+$/.test(upper) ? `AS${upper}` : '');
    }),
    cidr: list(source.cidr).filter((value) => parseCidr(value)),
    nodes: list(source.nodes),
    groups: list(source.groups)
  };
  if (!MATCH_FIELDS.some((field) => match[field].length > 0)) return null;
  return {
    id: normalizeString(rule.id) || `rule_${index + 1}`,
    effect,
    match,
    note: normalizeString(rule.note).slice(0, 200)
  };
}

/**
 * 规则是否命中某个出口。同一字段内是「或」，不同字段之间是「且」
 * （例：country=US 且 region=California）。
 * exit = { identity, geo: { country, region, city, asn, ip }, groups: Set<groupId> }
 */
function ruleMatchesExit(rule, exit) {
  if (!rule || !exit) return false;
  const geo = exit.geo || {};
  const m = rule.match;
  const checks = [];
  if (m.country.length) checks.push(Boolean(geo.country) && m.country.includes(String(geo.country).toUpperCase()));
  if (m.region.length) checks.push(Boolean(geo.region) && m.region.includes(String(geo.region).toLowerCase()));
  if (m.city.length) checks.push(Boolean(geo.city) && m.city.includes(String(geo.city).toLowerCase()));
  if (m.asn.length) checks.push(Boolean(geo.asn) && m.asn.includes(String(geo.asn).toUpperCase()));
  if (m.cidr.length) checks.push(Boolean(geo.ip) && m.cidr.some((cidr) => cidrContains(cidr, geo.ip)));
  if (m.nodes.length) checks.push(Boolean(exit.identity) && m.nodes.includes(exit.identity));
  if (m.groups.length) {
    const groups = exit.groups instanceof Set ? exit.groups : new Set(exit.groups || []);
    checks.push(m.groups.some((group) => groups.has(group)));
  }
  return checks.length > 0 && checks.every(Boolean);
}

// ── 判定 ───────────────────────────────────────────────────────────────────

/**
 * 出口对上游的判定。
 * @returns {{ status: 'allowed'|'denied'|'unknown', source: 'rule'|'evidence'|'hint'|'none',
 *             detail: string, ruleId?: string, evidence?: object, soft?: boolean }}
 *   soft = 依据只是预置提示（UI 显示为「提示」，可测试推翻）。
 */
function evaluateExit(input = {}) {
  const exit = input.exit || {};
  const now = Number(input.now) || Date.now();
  const ttlMs = Number(input.evidenceTtlMs) > 0 ? Number(input.evidenceTtlMs) : DEFAULT_EVIDENCE_TTL_MS;
  const rules = Array.isArray(input.rules) ? input.rules : [];
  for (const rule of rules) {
    if (ruleMatchesExit(rule, exit)) {
      return {
        status: rule.effect === 'deny' ? 'denied' : 'allowed',
        source: 'rule',
        ruleId: rule.id,
        detail: rule.note || (rule.effect === 'deny' ? '命中拒绝规则' : '命中允许规则')
      };
    }
  }
  const scopedEvidence = Array.isArray(input.scopedEvidence)
    ? input.scopedEvidence
    : (Array.isArray(input.evidence) ? input.evidence : []);
  const provider = normalizeString(input.provider).toLowerCase();
  const upstreamId = normalizeUpstreamId(input.upstreamId || input.upstream && input.upstream.id);
  const accountRef = normalizeString(input.accountRef);
  const credentialGeneration = input.credentialGeneration === undefined || input.credentialGeneration === null
    ? '' : normalizeString(input.credentialGeneration);
  const nodeId = normalizeString(input.nodeId || exit.nodeId || exit.identity);
  const exitIp = normalizeString(input.exitIp || exit.geo && exit.geo.ip);
  const modelFamily = normalizeString(input.modelFamily).toLowerCase();
  const matchingScoped = scopedEvidence
    .map((entry) => normalizeEvidenceRecord(entry))
    .filter((entry) => entry && entry.usableForBlocking
      && (!provider || entry.provider === provider)
      && (!upstreamId || entry.upstreamId === upstreamId)
      && (!accountRef || entry.scope !== SCOPES.ACCOUNT_UPSTREAM || entry.accountRef === accountRef)
      && (entry.scope !== SCOPES.ACCOUNT_UPSTREAM || !entry.credentialGeneration
        || (credentialGeneration && entry.credentialGeneration === credentialGeneration))
      && (!nodeId || !entry.nodeId || entry.nodeId === nodeId)
      && (!exitIp || !entry.exitIp || entry.exitIp === exitIp)
      && (!modelFamily || !entry.modelFamily || entry.modelFamily === modelFamily))
    .sort((a, b) => Number(b.at) - Number(a.at));
  const evidence = matchingScoped[0]
    || (input.evidence && input.exitKey ? input.evidence[input.exitKey] : null);
  const evidenceHasScope = evidence && evidence.scope && evidence.scope !== SCOPES.LEGACY;
  const scopedContextMissing = evidenceHasScope
    && (!provider || !upstreamId || (evidence.scope === SCOPES.ACCOUNT_UPSTREAM && !accountRef));
  const legacyEvidence = evidence && (!evidenceHasScope || scopedContextMissing)
    ? classifyLegacyEvidence(evidence) : evidence;
  const candidate = legacyEvidence && legacyEvidence.scope === SCOPES.LEGACY ? legacyEvidence : evidence;
  const fresh = candidate && Number(candidate.at) + ttlMs > now ? candidate : null;
  if (fresh && fresh.usableForBlocking !== false && (fresh.status === 'blocked' || fresh.status === 'ok')) {
    return {
      status: fresh.status === 'blocked' ? 'denied' : 'allowed',
      source: 'evidence',
      evidence: fresh,
      detail: fresh.reason || (fresh.status === 'blocked' ? '实测被拒' : '实测可用')
    };
  }
  const hints = Array.isArray(input.hints) ? input.hints : [];
  for (const hint of hints) {
    if (ruleMatchesExit(hint, exit)) {
      return { status: hint.effect === 'deny' ? 'denied' : 'allowed', source: 'hint', soft: true, detail: hint.note || '预置地区提示' };
    }
  }
  if (legacyEvidence && legacyEvidence.scope === SCOPES.LEGACY) {
    // Compatibility reads are retained for diagnostics and UI hints only.
    // A node-only historical "blocked" record must not deny every account or
    // provider that happens to use the same exit. Explicit hints still apply
    // above because they are a separate, authoritative policy layer.
    return {
      status: 'unknown',
      source: 'legacy',
      soft: true,
      evidence: legacyEvidence,
      detail: legacyEvidence.reason || '旧版未限定范围的实测，仅作提示'
    };
  }
  if (fresh && fresh.status === 'reachable') {
    return { status: 'allowed', source: 'evidence', evidence: fresh, detail: fresh.reason || '可连通（未验证认证阶段）' };
  }
  return { status: 'unknown', source: 'none', detail: '尚未测试' };
}

// ── 存储（app_kv）──────────────────────────────────────────────────────────

function normalizePolicy(raw) {
  const doc = raw && typeof raw === 'object' ? raw : {};
  const rules = (Array.isArray(doc.rules) ? doc.rules : []).slice(0, MAX_RULES)
    .map((rule, index) => normalizeRule(rule, index)).filter(Boolean);
  const ttl = Math.round(Number(doc.evidenceTtlMs) || 0);
  return {
    rules,
    // 0 = 跟随全局（server config 的 egressEvidenceTtlMs）。
    evidenceTtlMs: ttl >= 60000 ? Math.min(ttl, 365 * 24 * 60 * 60 * 1000) : 0,
    credentialedProbe: doc.credentialedProbe === true,
    updatedAt: Number(doc.updatedAt) || 0
  };
}

function readUpstreamPolicy(fs, aiHomeDir, upstreamId) {
  const id = normalizeUpstreamId(upstreamId);
  if (!id) return normalizePolicy(null);
  try {
    return normalizePolicy(readJsonValue(fs, aiHomeDir, `${POLICY_KEY_PREFIX}${id}`));
  } catch (_error) {
    return normalizePolicy(null);
  }
}

function writeUpstreamPolicy(fs, aiHomeDir, upstreamId, policy, now = Date.now()) {
  const id = normalizeUpstreamId(upstreamId);
  if (!id) throw new Error('invalid_upstream_id');
  const normalized = { ...normalizePolicy(policy), updatedAt: now };
  if (!writeJsonValue(fs, aiHomeDir, `${POLICY_KEY_PREFIX}${id}`, normalized)) throw new Error('upstream_policy_write_failed');
  return normalized;
}

function normalizeEvidenceEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!EVIDENCE_STATUSES.includes(raw.status)) return null;
  const scoped = normalizeEvidenceRecord({ ...raw, at: Number(raw.at) || 0 });
  return {
    ...((scoped && scoped.scope !== SCOPES.LEGACY) ? scoped : {}),
    status: raw.status,
    reason: normalizeString(raw.reason).slice(0, 200),
    source: EVIDENCE_SOURCES.includes(raw.source) ? raw.source : 'probe',
    at: Number(raw.at) || 0,
    accountRef: normalizeString(raw.accountRef),
    ...(raw.scope ? { scope: normalizeString(raw.scope) } : {}),
    ...(raw.provider ? { provider: normalizeString(raw.provider).toLowerCase() } : {}),
    ...(raw.upstreamId ? { upstreamId: normalizeUpstreamId(raw.upstreamId) } : {}),
    ...(raw.nodeId ? { nodeId: normalizeString(raw.nodeId) } : {}),
    ...(raw.exitIp ? { exitIp: normalizeString(raw.exitIp) } : {}),
    ...(raw.modelFamily ? { modelFamily: normalizeString(raw.modelFamily).toLowerCase() } : {}),
    ...(raw.credentialGeneration !== undefined ? { credentialGeneration: normalizeString(raw.credentialGeneration) } : {}),
    ...(raw.confidence !== undefined && scoped ? { confidence: scoped.confidence } : {}),
    usableForBlocking: Boolean(scoped && scoped.usableForBlocking)
  };
}

function readUpstreamEvidence(fs, aiHomeDir, upstreamId) {
  const id = normalizeUpstreamId(upstreamId);
  if (!id) return {};
  try {
    const doc = readJsonValue(fs, aiHomeDir, `${EVIDENCE_KEY_PREFIX}${id}`) || {};
    const out = {};
    Object.entries(doc).forEach(([exitKey, entry]) => {
      const normalized = normalizeEvidenceEntry(entry);
      if (exitKey && normalized) out[exitKey] = normalized;
    });
    return out;
  } catch (_error) {
    return {};
  }
}

/** 记一条实测（同一出口只保留最新一条）。超出上限时丢最旧的。 */
function recordUpstreamEvidence(fs, aiHomeDir, upstreamId, exitKey, entry, now = Date.now()) {
  const id = normalizeUpstreamId(upstreamId);
  const key = normalizeString(exitKey);
  const normalized = normalizeEvidenceEntry({ ...entry, at: entry && entry.at ? entry.at : now });
  if (!id || !key || !normalized) return false;
  const current = readUpstreamEvidence(fs, aiHomeDir, id);
  current[key] = normalized;
  const keys = Object.keys(current);
  if (keys.length > MAX_EVIDENCE_PER_UPSTREAM) {
    keys.sort((a, b) => current[a].at - current[b].at)
      .slice(0, keys.length - MAX_EVIDENCE_PER_UPSTREAM)
      .forEach((oldest) => { delete current[oldest]; });
  }
  return writeJsonValue(fs, aiHomeDir, `${EVIDENCE_KEY_PREFIX}${id}`, current);
}

/** 手动重置：exitKeys 为空 = 清空该上游的全部实测。 */
function resetUpstreamEvidence(fs, aiHomeDir, upstreamId, exitKeys) {
  const id = normalizeUpstreamId(upstreamId);
  if (!id) return 0;
  const keys = Array.isArray(exitKeys) ? exitKeys.map(normalizeString).filter(Boolean) : [];
  if (keys.length === 0) {
    const count = Object.keys(readUpstreamEvidence(fs, aiHomeDir, id)).length;
    deleteJsonValue(fs, aiHomeDir, `${EVIDENCE_KEY_PREFIX}${id}`);
    return count;
  }
  const current = readUpstreamEvidence(fs, aiHomeDir, id);
  let removed = 0;
  keys.forEach((key) => {
    if (current[key]) { delete current[key]; removed += 1; }
  });
  writeJsonValue(fs, aiHomeDir, `${EVIDENCE_KEY_PREFIX}${id}`, current);
  return removed;
}

/** 到期需要重测的出口（只看「被拒」与「可连通」的实测；ok 到期同样重测）。 */
function listExpiredEvidence(evidence, ttlMs, now = Date.now()) {
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_EVIDENCE_TTL_MS;
  return Object.entries(evidence || {})
    .filter(([, entry]) => entry && Number(entry.at) + ttl <= now)
    .map(([exitKey]) => exitKey);
}

function nodeExitKey(identity) {
  return identity ? `node:${identity}` : '';
}

function ipExitKey(ip) {
  return ip ? `ip:${ip}` : '';
}

module.exports = {
  DEFAULT_EVIDENCE_TTL_MS,
  EVIDENCE_SOURCES,
  EVIDENCE_STATUSES,
  MATCH_FIELDS,
  RULE_EFFECTS,
  cidrContains,
  evaluateExit,
  ipExitKey,
  listExpiredEvidence,
  nodeExitKey,
  normalizePolicy,
  normalizeRule,
  normalizeUpstreamId,
  readUpstreamEvidence,
  readUpstreamPolicy,
  recordUpstreamEvidence,
  resetUpstreamEvidence,
  ruleMatchesExit,
  writeUpstreamPolicy
};
