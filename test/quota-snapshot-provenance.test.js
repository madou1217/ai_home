'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  readAccountUsageSnapshot,
  writeAccountUsageSnapshot
} = require('../lib/account/usage-snapshot-store');
const { buildQuotaSnapshotProvenance } = require('../lib/usage/quota/probe-result');

test('quota provenance keeps an explicit source and recomputes freshness', () => {
  const snapshot = {
    capturedAt: 1000,
    source: 'codex_app_server',
    provenance: {
      id: 'codex_app_server',
      kind: 'provider',
      authority: 90,
      confidence: 0.9,
      url: 'https://example.test/quota',
      fetchedAt: '2026-10-20T00:00:00.000Z',
      stale: false
    }
  };

  const fresh = buildQuotaSnapshotProvenance(snapshot, { now: 1000 + 60_000, maxAgeMs: 300_000 });
  assert.equal(fresh.id, 'codex_app_server');
  assert.equal(fresh.authority, 90);
  assert.equal(fresh.confidence, 0.9);
  assert.equal(fresh.url, 'https://example.test/quota');
  assert.equal(fresh.stale, false);

  const stale = buildQuotaSnapshotProvenance(snapshot, { now: 1000 + 600_000, maxAgeMs: 300_000 });
  assert.equal(stale.stale, true);
});

test('usage snapshot store adds provenance without changing the legacy source field', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-quota-provenance-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'oauth:codex:provenance@example.com'
  });

  writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, {
    schemaVersion: 1,
    kind: 'codex_oauth_status',
    capturedAt: Date.now() - 600_000,
    source: 'codex_app_server',
    entries: []
  });

  const stored = readAccountUsageSnapshot(fs, aiHomeDir, accountRef);
  assert.equal(stored.source, 'codex_app_server');
  assert.equal(stored.provenance.id, 'codex_app_server');
  assert.equal(stored.provenance.stale, true);
});
