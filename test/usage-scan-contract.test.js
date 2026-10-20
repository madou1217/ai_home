'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  USAGE_SCAN_KIND,
  USAGE_SCAN_SOURCE_ID,
  USAGE_SCAN_STATUS,
  createUsageScanRequest,
  createUsageScanResult,
  formatUsageScanProvenance,
  normalizeUsageScanProviderResult
} = require('../lib/usage/usage-scan-contract');

const NOW = Date.parse('2026-10-20T00:00:00.000Z');

test('usage.scan reports ok with source and counts when records were scanned', () => {
  const result = createUsageScanResult({
    providers: ['claude'],
    now: NOW,
    result: {
      providers: { claude: { files: 2, records: 3, prompts: 1, skipped: 0 } },
      files: 2,
      records: 3,
      prompts: 1
    }
  });

  assert.equal(result.kind, USAGE_SCAN_KIND);
  assert.equal(result.status, USAGE_SCAN_STATUS.OK);
  assert.equal(result.source.id, USAGE_SCAN_SOURCE_ID);
  assert.equal(result.source.fetchedAt, '2026-10-20T00:00:00.000Z');
  assert.equal(result.stale, false);
  assert.equal(result.counts.records, 3);
  assert.equal(result.providers.claude.status, 'ok');
  assert.match(formatUsageScanProvenance(result), /status=ok records=3/);
});

test('usage.scan distinguishes empty (scanned files, zero records) from unavailable', () => {
  const empty = createUsageScanResult({
    providers: ['claude'],
    now: NOW,
    result: { providers: { claude: { files: 1, records: 0 } } }
  });
  assert.equal(empty.status, USAGE_SCAN_STATUS.EMPTY);
  assert.equal(empty.warnings.some((warning) => warning.code === 'usage_scan_empty'), true);

  const unavailable = createUsageScanResult({
    providers: ['agy'],
    now: NOW,
    result: { providers: { agy: { files: 0, records: 0, reason: 'agy_local_conversations_are_protobuf' } } }
  });
  assert.equal(unavailable.status, USAGE_SCAN_STATUS.UNAVAILABLE);
  assert.equal(unavailable.providers.agy.status, 'unavailable');
  assert.equal(unavailable.warnings.some((warning) => warning.code === 'usage_scan_provider_unavailable'), true);
});

test('usage.scan keeps partial scans observable instead of silently dropping providers', () => {
  const result = createUsageScanResult({
    providers: ['claude', 'agy'],
    now: NOW,
    result: {
      providers: {
        claude: { files: 1, records: 2 },
        agy: { files: 0, records: 0, reason: 'no_local_conversation_reader' }
      }
    }
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.attempts.find((attempt) => attempt.provider === 'agy').status, 'unavailable');
  assert.equal(result.warnings.some((warning) => warning.code === 'usage_scan_provider_unavailable'), true);
});

test('usage.scan normalization preserves provider-specific fields (deferrals/reindex)', () => {
  const entry = normalizeUsageScanProviderResult({
    files: 2,
    records: 0,
    filesDeferred: 3,
    reindexRequired: 1,
    ambiguousSessions: 4
  });
  assert.equal(entry.status, 'empty');
  assert.equal(entry.filesDeferred, 3);
  assert.equal(entry.reindexRequired, 1);
  assert.equal(entry.errors, 4);
});

test('usage.scan request lists providers deterministically', () => {
  assert.deepEqual(createUsageScanRequest({ providers: ['Claude', 'agy', 'claude'] }).providers, ['agy', 'claude']);
});

test('model usage service scan returns the usage.scan contract fields', (t) => {
  let DatabaseSync;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const { createModelUsageService } = require('../lib/usage/model-usage-service');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-usage-scan-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createModelUsageService({
    fs,
    path,
    aiHomeDir: path.join(root, '.ai_home'),
    hostHomeDir: root,
    DatabaseSync
  });

  const result = service.scan({ providers: ['claude'], now: NOW });
  assert.equal(result.kind, USAGE_SCAN_KIND);
  assert.equal(result.status, USAGE_SCAN_STATUS.EMPTY);
  assert.equal(result.source.id, USAGE_SCAN_SOURCE_ID);
  assert.equal(result.providers.claude.records, 0);
});
