const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  prepareDesktopClientProfile,
  resolveDesktopClientProfileDir
} = require('../lib/cli/services/ai-cli/desktop-client-profile');

const ACCOUNT_REF = 'acct_66c0a9207ebbe639c664';

test('desktop client profile resolves an account-scoped provider directory', () => {
  assert.equal(
    resolveDesktopClientProfileDir('/tmp/.ai_home', 'CLAUDE', ACCOUNT_REF),
    path.join('/tmp/.ai_home', 'desktop-clients', 'claude', ACCOUNT_REF)
  );
});

test('desktop client profile rejects invalid providers and account refs', () => {
  assert.equal(resolveDesktopClientProfileDir('/tmp/.ai_home', 'unknown', ACCOUNT_REF), '');
  assert.equal(resolveDesktopClientProfileDir('/tmp/.ai_home', 'claude', '../escape'), '');
  assert.equal(resolveDesktopClientProfileDir('', 'claude', ACCOUNT_REF), '');
});

test('desktop client profile creates and hardens the account directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-desktop-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDir = prepareDesktopClientProfile({
    fs,
    path,
    aiHomeDir: path.join(root, '.ai_home'),
    provider: 'claude',
    accountRef: ACCOUNT_REF
  });

  assert.equal(fs.statSync(profileDir).isDirectory(), true);
  assert.equal(fs.statSync(profileDir).mode & 0o777, 0o700);
});
