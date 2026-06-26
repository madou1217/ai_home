const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  verifyImportedAccounts,
  formatPostImportValidationReport
} = require('../lib/migration/post-import-verify');

test('verifyImportedAccounts returns deterministic pass/fail details', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-post-import-'));
  try {
    const codex1 = path.join(tempRoot, 'profiles', 'codex', '1');
    const codex2 = path.join(tempRoot, 'profiles', 'codex', '2');
    fs.mkdirSync(codex1, { recursive: true });
    fs.mkdirSync(codex2, { recursive: true });

    const report = verifyImportedAccounts({
      accounts: [
        { tool: 'gemini', id: '3' },
        { tool: 'codex', id: '2' },
        { tool: 'codex', id: '1' }
      ],
      getProfileDir: (tool, id) => path.join(tempRoot, 'profiles', tool, String(id)),
      checkStatus: (tool, profileDir) => {
        if (tool === 'codex' && profileDir.endsWith('/1')) {
          return { configured: true, accountName: 'alice@example.com' };
        }
        if (tool === 'codex' && profileDir.endsWith('/2')) {
          return { configured: false, accountName: 'bob@example.com' };
        }
        return { configured: true, accountName: 'unknown' };
      },
      startupProbe: (tool, profileDir) => {
        if (tool === 'codex' && profileDir.endsWith('/1')) return { ok: true };
        return { ok: true };
      }
    });

    assert.equal(report.total, 3);
    assert.equal(report.passed, 1);
    assert.equal(report.failed, 2);
    assert.equal(report.entries[0].tool, 'codex');
    assert.equal(report.entries[0].id, '1');
    assert.equal(report.entries[0].status, 'pass');
    assert.deepEqual(report.entries[1].reasons, ['not_authenticated']);
    assert.deepEqual(report.entries[2].reasons, ['profile_missing']);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('formatPostImportValidationReport prints failed entries', () => {
  const text = formatPostImportValidationReport({
    total: 3,
    passed: 1,
    failed: 2,
    passRate: 33.33,
    entries: [
      { tool: 'codex', id: '1', status: 'pass', reasons: [] },
      { tool: 'codex', id: '2', status: 'fail', reasons: ['not_authenticated'] },
      { tool: 'gemini', id: '3', status: 'fail', reasons: ['profile_missing'] }
    ]
  });

  assert.match(text, /PASS 1\/3/);
  assert.match(text, /codex:2 -> not_authenticated/);
  assert.match(text, /gemini:3 -> profile_missing/);
});
