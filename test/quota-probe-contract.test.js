'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  QUOTA_PROBE_KIND,
  attachQuotaProbeProvenance,
  formatQuotaProbeProvenance,
  normalizeQuotaProbeResult
} = require('../lib/usage/quota/probe-result');

const NOW = Date.parse('2026-10-20T00:00:00.000Z');

test('quota.probe normalizes an ok snapshot with source/capturedAt and preserves provider source string', () => {
  const result = normalizeQuotaProbeResult({
    provider: 'qoder',
    accountRef: 'acct_1',
    now: NOW,
    maxAgeMs: 60 * 60 * 1000,
    result: {
      strategyId: 'qoder-http',
      attempts: [],
      snapshot: {
        kind: 'qoder_credit_usage',
        source: 'qoder-account-api',
        capturedAt: NOW - 30 * 60 * 1000,
        entries: []
      }
    }
  });

  assert.equal(result.kind, QUOTA_PROBE_KIND);
  assert.equal(result.status, 'ok');
  assert.equal(result.source.id, 'qoder-account-api');
  assert.equal(result.source.kind, 'provider');
  assert.equal(result.capturedAt, NOW - 30 * 60 * 1000);
  assert.equal(result.stale, false);

  // 快照自身的 `source` 是恢复/匹配用的字符串身份，归一不能覆盖它。
  const snapshot = attachQuotaProbeProvenance({ source: 'qoder-account-api', capturedAt: NOW - 10 * 60 * 1000 }, result);
  assert.equal(snapshot.source, 'qoder-account-api');
  assert.equal(snapshot.provenance.id, 'qoder-account-api');
  assert.equal(snapshot.provenance.stale, false);
});

test('quota.probe marks stale snapshots without pretending data is missing', () => {
  const result = normalizeQuotaProbeResult({
    provider: 'codex',
    now: NOW,
    maxAgeMs: 5 * 60 * 1000,
    result: {
      snapshot: { kind: 'codex_oauth_status', source: 'codex_app_server', capturedAt: NOW - 30 * 60 * 1000 }
    }
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.stale, true);
  assert.match(formatQuotaProbeProvenance(result), /stale=true/);
});

test('quota.probe keeps not_applicable as a conclusion, not a failure', () => {
  const result = normalizeQuotaProbeResult({
    provider: 'qoder',
    result: { notApplicable: true, reason: 'credits_not_applicable', attempts: [] }
  });
  assert.equal(result.status, 'not_applicable');
  assert.equal(result.notApplicable, true);
  assert.equal(result.error, '');
  assert.equal(result.reason, 'credits_not_applicable');
});

test('quota.probe reports unavailable with its error and a warning when no error was given', () => {
  const failed = normalizeQuotaProbeResult({
    provider: 'kiro',
    result: { attempts: [{ strategyId: 'kiro-http', error: 'http_401', auth: true }] }
  });
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.error, 'probe_failed');
  assert.equal(failed.auth, true);

  const silent = normalizeQuotaProbeResult({ provider: 'kiro', result: {} });
  assert.equal(silent.status, 'unavailable');
  assert.equal(silent.warnings.some((warning) => warning.code === 'quota_unavailable_without_error'), true);
});
