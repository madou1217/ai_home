'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsagePresenterService } = require('../lib/cli/services/usage/presenter');
const { USAGE_SNAPSHOT_KINDS } = require('../lib/account/usage-remaining');

test('CodeBuddy usage detailed CLI prints aggregate and packages without raw JSON or fake percentages', () => {
  const presenter = createUsagePresenterService();
  const lines = presenter.formatUsageSnapshotLines({ kind: USAGE_SNAPSHOT_KINDS.codebuddy, entries: [
    { bucket: 'credits', remainingUnits: 100, totalUnits: 600, remainingPct: 100 / 6, unitType: 'credits' },
    { bucket: 'trial', category: 'detail', remainingUnits: 0, totalUnits: 500, remainingPct: 0 },
    { bucket: 'unknown', category: 'detail', remainingUnits: null, totalUnits: null, remainingPct: null }
  ] });
  assert.equal(lines[0], 'credits: 100/600 credits remaining (16.67%)');
  assert.match(lines[1], /trial: 0\/500/);
  assert.match(lines[2], /unknown\/unknown.*\(unknown\)/);
});

test('unknown snapshot kinds retain their previous diagnostic JSON representation', () => {
  const snapshot = { kind: 'unrelated', value: 123 };
  assert.deepEqual(createUsagePresenterService().formatUsageSnapshotLines(snapshot), [JSON.stringify(snapshot)]);
});
