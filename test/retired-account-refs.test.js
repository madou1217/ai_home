'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonValue } = require('../lib/server/app-state-store');
const { readRetiredAccountRef } = require('../lib/account/retired-account-refs');

const ACCOUNT_REF = 'acct_c3ccfeed8592ee54aea8';

function createStore(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-retired-account-refs-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return aiHomeDir;
}

test('historical deletion markers identify stale affinity without inventing a provider', (t) => {
  const aiHomeDir = createStore(t);
  writeJsonValue(fs, aiHomeDir, `account:deleted:${ACCOUNT_REF}`, { deletedAt: 1789556602076 });

  assert.deepEqual(readRetiredAccountRef(fs, aiHomeDir, ACCOUNT_REF), {
    provider: '', retiredAt: 1789556602076
  });
});

test('retirement records keep their provider and outrank historical deletion markers', (t) => {
  const aiHomeDir = createStore(t);
  writeJsonValue(fs, aiHomeDir, `account:retired:${ACCOUNT_REF}`, { provider: 'codex', retiredAt: 100 });
  writeJsonValue(fs, aiHomeDir, `account:deleted:${ACCOUNT_REF}`, { deletedAt: 200 });

  assert.deepEqual(readRetiredAccountRef(fs, aiHomeDir, ACCOUNT_REF), {
    provider: 'codex', retiredAt: 100
  });
});

test('unknown refs and malformed deletion markers do not authorize pool fallback', (t) => {
  const aiHomeDir = createStore(t);
  assert.equal(readRetiredAccountRef(fs, aiHomeDir, ACCOUNT_REF), null);
  for (const deletedAt of [undefined, null, 0, -1, '1789556602076']) {
    const markerDir = createStore(t);
    writeJsonValue(fs, markerDir, `account:deleted:${ACCOUNT_REF}`, { deletedAt });
    assert.equal(readRetiredAccountRef(fs, markerDir, ACCOUNT_REF), null);
  }
});
