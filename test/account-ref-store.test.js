'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  isAccountRef,
  resolveAccountRef,
  upsertAccountRef
} = require('../lib/server/account-ref-store');
const { getAppStateDbPath } = require('../lib/server/app-state-store');

test('account ref is stable and hides internal account identity', () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-ref-'));
  try {
    const account = {
      provider: 'codex',
      accountId: '3',
      accountKey: 'codex:3',
      uniqueKey: 'oauth:codex:hidden@example.com'
    };
    const first = upsertAccountRef(fs, aiHomeDir, account);
    const second = upsertAccountRef(fs, aiHomeDir, { ...account, accountId: '9', accountKey: 'codex:9' });

    assert.equal(first, second);
    assert.equal(isAccountRef(first), true);
    assert.equal(first.includes('hidden@example.com'), false);
    assert.equal(first.includes('oauth:codex'), false);
    assert.equal(first.includes('codex:3'), false);
    assert.equal(fs.existsSync(getAppStateDbPath(aiHomeDir)), true);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('account ref resolves to internal scope from app state database', () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-ref-resolve-'));
  try {
    const accountRef = upsertAccountRef(fs, aiHomeDir, {
      provider: 'gemini',
      accountId: 'g1',
      accountKey: 'gemini:g1',
      uniqueKey: 'oauth:gemini:user@example.com'
    });

    const resolved = resolveAccountRef(fs, aiHomeDir, accountRef);

    assert.equal(resolved.accountRef, accountRef);
    assert.equal(resolved.provider, 'gemini');
    assert.equal(resolved.accountId, 'g1');
    assert.equal(resolved.accountKey, 'gemini:g1');
    assert.equal(resolved.uniqueKey, 'oauth:gemini:user@example.com');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});
