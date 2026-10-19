'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_EVIDENCE_TTL_MS,
  cidrContains,
  evaluateExit,
  ipExitKey,
  listExpiredEvidence,
  nodeExitKey,
  normalizePolicy,
  normalizeRule,
  readUpstreamEvidence,
  readUpstreamPolicy,
  recordUpstreamEvidence,
  resetUpstreamEvidence,
  ruleMatchesExit,
  writeUpstreamPolicy
} = require('../lib/server/egress-region-policy');
const {
  isRegionDenied,
  listUpstreams,
  resolveAccountUpstream,
  upstreamHints
} = require('../lib/server/egress-upstream');
const { validateProviderDescriptor } = require('../lib/providers/contract');
const { getProviderCapability } = require('../lib/providers');
const { listAggregatorGroups } = require('../lib/cli/services/toolkit/subscription-aggregator/group-nodes');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-region-policy-'));
}

const HK = { identity: 'ss|hk.example|443', geo: { country: 'HK', region: 'Hong Kong', city: 'Hong Kong', asn: 'AS9304', ip: '203.0.113.7' } };
const US = { identity: 'ss|us.example|443', geo: { country: 'US', region: 'California', city: 'Los Angeles', asn: 'AS3214', ip: '198.51.100.9' } };

test('normalizeRule keeps only valid match values and drops empty rules', () => {
  const rule = normalizeRule({ effect: 'allow', match: { country: ['us', 'xx1'], asn: ['3214', 'AS9304', 'bad'], cidr: ['10.0.0.0/8', 'nope'] } });
  assert.equal(rule.effect, 'allow');
  assert.deepEqual(rule.match.country, ['US']);
  assert.deepEqual(rule.match.asn, ['AS3214', 'AS9304']);
  assert.deepEqual(rule.match.cidr, ['10.0.0.0/8']);
  assert.equal(normalizeRule({ match: {} }), null);
  assert.equal(normalizeRule({ effect: 'weird', match: { city: 'Tokyo' } }).effect, 'deny');
});

test('cidrContains handles prefixes and bare addresses', () => {
  assert.equal(cidrContains('203.0.113.0/24', '203.0.113.7'), true);
  assert.equal(cidrContains('203.0.113.0/24', '203.0.114.7'), false);
  assert.equal(cidrContains('198.51.100.9', '198.51.100.9'), true);
  assert.equal(cidrContains('0.0.0.0/0', '1.2.3.4'), true);
  assert.equal(cidrContains('bad', '1.2.3.4'), false);
});

test('ruleMatchesExit: OR within a field, AND across fields', () => {
  const rule = normalizeRule({ match: { country: ['US', 'JP'], region: ['california'] } });
  assert.equal(ruleMatchesExit(rule, US), true);
  assert.equal(ruleMatchesExit(rule, { ...US, geo: { ...US.geo, region: 'Oregon' } }), false);
  assert.equal(ruleMatchesExit(rule, HK), false);
  const byGroup = normalizeRule({ match: { groups: ['p1:g1'] } });
  assert.equal(ruleMatchesExit(byGroup, { ...HK, groups: new Set(['p1:g1']) }), true);
  assert.equal(ruleMatchesExit(byGroup, HK), false);
  const byNode = normalizeRule({ match: { nodes: [US.identity] } });
  assert.equal(ruleMatchesExit(byNode, US), true);
  // 没有 geo 的出口不会被地理字段命中（未知 ≠ 命中）。
  assert.equal(ruleMatchesExit(normalizeRule({ match: { country: 'HK' } }), { identity: 'x' }), false);
});

test('evaluateExit precedence: rule > fresh evidence > hint > reachable > unknown', () => {
  const now = 1_000_000_000;
  const hints = [normalizeRule({ match: { country: ['HK'] }, note: 'hint' })];
  const exitKey = nodeExitKey(HK.identity);

  assert.equal(evaluateExit({ exit: HK, hints, now }).source, 'hint');
  assert.equal(evaluateExit({ exit: HK, hints, now }).status, 'denied');
  assert.equal(evaluateExit({ exit: HK, hints, now }).soft, true);

  // 实测 ok 推翻提示。
  const okEvidence = { [exitKey]: { status: 'ok', at: now - 1000 } };
  assert.deepEqual(
    [evaluateExit({ exit: HK, hints, now, exitKey, evidence: okEvidence }).status, evaluateExit({ exit: HK, hints, now, exitKey, evidence: okEvidence }).source],
    ['allowed', 'evidence']
  );
  // 过期的实测不再算数，回落到提示。
  assert.equal(evaluateExit({ exit: HK, hints, now, exitKey, evidence: okEvidence, evidenceTtlMs: 500 }).source, 'hint');
  // reachable 弱于提示。
  const reachable = { [exitKey]: { status: 'reachable', at: now } };
  assert.equal(evaluateExit({ exit: HK, hints, now, exitKey, evidence: reachable }).source, 'hint');
  assert.equal(evaluateExit({ exit: US, hints, now, exitKey: nodeExitKey(US.identity), evidence: { [nodeExitKey(US.identity)]: { status: 'reachable', at: now } } }).status, 'allowed');
  // 用户规则最优先（即使有实测 ok）。
  const rules = [normalizeRule({ id: 'r1', match: { city: ['hong kong'] } })];
  const ruled = evaluateExit({ exit: HK, rules, hints, now, exitKey, evidence: okEvidence });
  assert.deepEqual([ruled.status, ruled.source, ruled.ruleId], ['denied', 'rule', 'r1']);
  // 首条命中生效。
  const ordered = [normalizeRule({ id: 'a', effect: 'allow', match: { country: 'HK' } }), normalizeRule({ id: 'd', match: { country: 'HK' } })];
  assert.equal(evaluateExit({ exit: HK, rules: ordered, now }).ruleId, 'a');
  assert.equal(evaluateExit({ exit: US, now }).status, 'unknown');
});

test('policy and evidence round-trip through app_kv with TTL listing and reset', () => {
  const home = tempHome();
  try {
    const written = writeUpstreamPolicy(fs, home, 'API.Anthropic.com', {
      rules: [{ match: { country: 'hk' } }, { match: {} }],
      evidenceTtlMs: 10,
      credentialedProbe: true
    }, 42);
    assert.equal(written.rules.length, 1);
    assert.equal(written.evidenceTtlMs, 0, 'TTL below 60s falls back to global');
    const read = readUpstreamPolicy(fs, home, 'api.anthropic.com');
    assert.equal(read.updatedAt, 42);
    assert.equal(read.credentialedProbe, true);
    assert.equal(normalizePolicy({ evidenceTtlMs: 120000 }).evidenceTtlMs, 120000);

    const now = 10_000_000;
    assert.equal(recordUpstreamEvidence(fs, home, 'api.anthropic.com', nodeExitKey('a'), { status: 'blocked', reason: 'reset', at: now - 5000 }), true);
    assert.equal(recordUpstreamEvidence(fs, home, 'api.anthropic.com', ipExitKey('1.2.3.4'), { status: 'ok', at: now }), true);
    assert.equal(recordUpstreamEvidence(fs, home, 'api.anthropic.com', 'node:x', { status: 'nonsense' }), false);
    const evidence = readUpstreamEvidence(fs, home, 'api.anthropic.com');
    assert.deepEqual(Object.keys(evidence).sort(), ['ip:1.2.3.4', 'node:a']);
    assert.deepEqual(listExpiredEvidence(evidence, 1000, now), ['node:a']);
    assert.deepEqual(listExpiredEvidence(evidence, 0, now), []);
    assert.ok(DEFAULT_EVIDENCE_TTL_MS > 1000);

    assert.equal(resetUpstreamEvidence(fs, home, 'api.anthropic.com', ['node:a', 'node:missing']), 1);
    assert.deepEqual(Object.keys(readUpstreamEvidence(fs, home, 'api.anthropic.com')), ['ip:1.2.3.4']);
    assert.equal(resetUpstreamEvidence(fs, home, 'api.anthropic.com'), 1);
    assert.deepEqual(readUpstreamEvidence(fs, home, 'api.anthropic.com'), {});
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('upstreams are derived per host: OAuth -> official with hints, API key relay -> own host without hints', () => {
  const oauth = resolveAccountUpstream({}, { provider: 'claude', accountRef: 'a1' });
  assert.equal(oauth.official, true);
  assert.ok(oauth.host, 'official host resolved');
  assert.ok(upstreamHints(oauth).length > 0, 'official upstream inherits descriptor hints');
  assert.ok(upstreamHints(oauth).every((hint) => hint.source && hint.asOf));

  const relay = resolveAccountUpstream({}, { provider: 'claude', accountRef: 'a2', apiKeyMode: true, baseUrl: 'https://relay.example.com/v1', openaiBaseUrl: 'https://relay.example.com/v1' });
  if (relay.host === 'relay.example.com') {
    assert.equal(relay.official, false);
    assert.deepEqual(upstreamHints(relay), []);
  }

  const upstreams = listUpstreams({}, {
    claude: [{ provider: 'claude', accountRef: 'a1' }, { provider: 'claude', accountRef: 'a3' }]
  });
  assert.equal(upstreams.length, 1);
  assert.deepEqual(upstreams[0].accounts, ['a1', 'a3']);
});

test('isRegionDenied: 451, declared signatures only for official upstreams, generic phrases everywhere', () => {
  const official = { provider: 'claude', official: true };
  const relay = { provider: 'claude', official: false };
  assert.equal(isRegionDenied(relay, { statusCode: 451 }), 'http_451');
  assert.equal(isRegionDenied(official, { text: '{"error":{"message":"Request not allowed"}}' }), 'request not allowed');
  assert.equal(isRegionDenied(relay, { text: 'Request not allowed' }), '');
  assert.equal(isRegionDenied(relay, { text: 'This service is not available in your region' }), 'not available in your region');
  assert.equal(isRegionDenied(official, { statusCode: 401, text: 'invalid x-api-key' }), '');
});

test('provider descriptors declare region policies with source and date', () => {
  for (const provider of ['claude', 'codex', 'gemini', 'agy']) {
    const egress = getProviderCapability(provider, 'egress');
    assert.ok(egress && egress.regionPolicy, `${provider} declares regionPolicy`);
    assert.ok(egress.regionPolicy.hints.every((hint) => hint.source && hint.asOf));
    assert.ok(egress.regionPolicy.denySignatures.length > 0);
  }
});

test('contract rejects region hints without source/date', () => {
  const build = (egress) => ({
    contractVersion: 1,
    id: 'demo',
    capabilities: { quota: { supported: false, reason: 'demo' }, egress }
  });
  assert.throws(() => validateProviderDescriptor(build({
    regionPolicy: { hints: [{ effect: 'deny', match: { country: ['CN'] } }] }
  })), /hint_source_missing/);
  // 只声明地区策略、不收窄 scheme 是合法的。
  const ok = validateProviderDescriptor(build({
    regionPolicy: { hints: [{ match: { country: ['CN'] }, source: 'https://x', asOf: '2026-10-19' }], denySignatures: ['Blocked Here'] }
  }));
  assert.deepEqual(ok.capabilities.egress.regionPolicy.denySignatures, ['blocked here']);
  assert.equal(ok.capabilities.egress.proxySchemes, undefined);
  assert.throws(() => validateProviderDescriptor(build({})), /egress_schemes_empty/);
});

test('listAggregatorGroups expands custom groups by names, include/exclude and nested members', () => {
  const { normalizeProfile } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-schema');
  const nodes = [
    { name: 'HK 01', protocol: 'ss', server: 'hk1', port: 1 },
    { name: 'US 01', protocol: 'ss', server: 'us1', port: 1 },
    { name: 'JP 01', protocol: 'ss', server: 'jp1', port: 1 }
  ];
  const profile = normalizeProfile({
    id: 'p1',
    name: 'Main',
    sources: { includeManualNodes: true },
    groups: {
      custom: [
        { id: 'g_us', name: 'US', nodes: { names: ['US 01'] } },
        { id: 'g_nohk', name: 'NoHK', nodes: { include: 'JP' }, members: ['group:g_us'] }
      ]
    }
  });
  const groups = listAggregatorGroups([profile], [], nodes);
  const byId = Object.fromEntries(groups.map((group) => [group.id, group.nodes.map((node) => node.name).sort()]));
  assert.deepEqual(byId['p1:g_us'], ['US 01']);
  assert.deepEqual(byId['p1:g_nohk'], ['JP 01', 'US 01']);
});
