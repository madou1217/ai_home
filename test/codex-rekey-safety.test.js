'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { codexOAuthAuth } = require('./codex-identity-fixtures');
const { writeAccountNativeAuth, writeAccountCredentials, readAccountNativeAuth } = require('../lib/server/account-credential-store');
const { writeDefaultAccountRef, readDefaultAccountRef } = require('../lib/account/default-account-store');
const { openAppStateDatabase, writeJsonValue, readJsonValue } = require('../lib/server/app-state-store');
const { planCodexIdentityRekey, applyCodexIdentityRekey, ledgerIsApplicable } = require('../lib/cli/services/account/codex-identity-rekey');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-rekey-safety-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  function account(email = 'fixture@example.invalid', userId = 'fixture-user', current = false) {
    const ref = registerAccountIdentity(fs, home, { provider: 'codex', identitySeed: `oauth:codex:${current ? userId : email}` }).accountRef;
    writeAccountNativeAuth(fs, home, ref, { auth: codexOAuthAuth({ email, userId }) }); return ref;
  }
  const ref = account();
  const plan = () => planCodexIdentityRekey({ fs, aiHomeDir: home }).ledger;
  const apply = ledger => applyCodexIdentityRekey({ fs, aiHomeDir: home, ledger });
  return { home, ref, account, plan, apply };
}

test('read-only planning leaves database bytes, mode and schema untouched', t => {
  const f = fixture(t), file = path.join(f.home, 'app-state.db');
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = hash(), mode = fs.statSync(file).mode;
  assert.equal(f.plan().summary.migrate, 1);
  assert.equal(hash(), before); assert.equal(fs.statSync(file).mode, mode);
});

test('an existing canonical target blocks old-to-new migration regardless of iteration order', t => {
  const f = fixture(t); f.account('new-name@example.invalid', 'fixture-user', true);
  const ledger = f.plan(); assert.equal(ledger.summary.conflict, 1);
  assert.equal(f.apply(ledger).applied, false); assert.ok(readAccountNativeAuth(fs, f.home, f.ref).auth);
});

test('API-key accounts are excluded instead of blocking an unrelated OAuth migration', t => {
  const f = fixture(t);
  const keyRef = registerAccountIdentity(fs, f.home, { provider: 'codex', identitySeed: 'api-key:codex:fixture' }).accountRef;
  writeAccountCredentials(fs, f.home, keyRef, { OPENAI_API_KEY: 'test-fixture-not-real' });
  const ledger = f.plan(); assert.equal(ledger.summary.not_applicable, 1); assert.equal(ledgerIsApplicable(ledger).applicable, true);
  assert.equal(f.apply(ledger).applied, true);
});

for (const mutate of [
  ledger => { ledger.summary.conflict = 0; ledger.summary.total = 0; },
  ledger => { ledger.entries = []; },
  ledger => { ledger.entries[0].new_account_ref = 'acct_aaaaaaaaaaaaaaaaaaaa'; },
  ledger => { ledger.entries.push(ledger.entries[0]); },
  ledger => { ledger.provider = 'grok'; },
  ledger => { ledger.schema_version = 1; },
  ledger => { ledger.to_vector = 'oauth:codex:<email>'; }
]) test('tampered or obsolete ledger cannot modify any identity', t => {
  const f = fixture(t), ledger = f.plan(); mutate(ledger);
  assert.equal(f.apply(ledger).applied, false); assert.ok(readAccountNativeAuth(fs, f.home, f.ref).auth);
});

test('credentials changed after dry-run invalidate the entire ledger', t => {
  const f = fixture(t), ledger = f.plan();
  writeAccountNativeAuth(fs, f.home, f.ref, { auth: codexOAuthAuth({ email: 'fixture@example.invalid', userId: 'different-user' }) });
  const result = f.apply(ledger); assert.equal(result.applied, false); assert.match(result.error, /stale/);
});

test('default scalar, structured values, JSON object keys and namespaced keys migrate atomically', t => {
  const f = fixture(t); writeDefaultAccountRef(fs, f.home, 'codex', f.ref);
  writeJsonValue(fs, f.home, 'fixture:state', { active: f.ref, peers: [f.ref], map: { [f.ref]: true } });
  writeJsonValue(fs, f.home, `fixture:${f.ref}:entry`, { accountRef: f.ref });
  const ledger = f.plan(), target = ledger.entries[0].new_account_ref;
  assert.equal(f.apply(ledger).applied, true);
  assert.equal(readDefaultAccountRef(fs, f.home, 'codex'), target);
  assert.deepEqual(readJsonValue(fs, f.home, 'fixture:state'), { active: target, peers: [target], map: { [target]: true } });
  assert.deepEqual(readJsonValue(fs, f.home, `fixture:${target}:entry`), { accountRef: target });
  const db = openAppStateDatabase(fs, f.home, { createIfMissing: false });
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); db.close();
});

for (const kind of ['root-hook', 'runtime-path', 'embedded-json-path']) test(`unhandled external reference is a blocker: ${kind}`, t => {
  const f = fixture(t);
  if (kind === 'root-hook') fs.writeFileSync(path.join(f.home, 'codex-cli-hook-state.json'), JSON.stringify({ desktopAccountRef: f.ref }));
  if (kind === 'runtime-path') fs.mkdirSync(path.join(f.home, 'run/accounts/codex', f.ref), { recursive: true });
  if (kind === 'embedded-json-path') writeJsonValue(fs, f.home, 'fixture:path', { path: `/x/${f.ref}/data` });
  const ledger = f.plan(); assert.equal(ledgerIsApplicable(ledger).applicable, false);
  assert.equal(f.apply(ledger).applied, false); assert.ok(readAccountNativeAuth(fs, f.home, f.ref).auth);
});

test('external writer reference appearing after planning prevents apply', t => {
  const f = fixture(t), ledger = f.plan();
  fs.writeFileSync(path.join(f.home, 'codex-cli-hook-state.json'), JSON.stringify({ desktopAccountRef: f.ref }));
  const result = f.apply(ledger); assert.equal(result.applied, false); assert.match(result.error, /external_references_changed/);
});

test('unique collision in a derived table rolls back all prior identity writes', t => {
  const f = fixture(t), ledger = f.plan(), target = ledger.entries[0].new_account_ref;
  const db = openAppStateDatabase(fs, f.home, { createIfMissing: false });
  db.exec('CREATE TABLE fixture_unique (account_ref TEXT UNIQUE)');
  const insert = db.prepare('INSERT INTO fixture_unique VALUES (?)'); insert.run(f.ref); insert.run(target); db.close();
  const result = f.apply(ledger); assert.equal(result.applied, false);
  assert.ok(readAccountNativeAuth(fs, f.home, f.ref).auth);
  assert.deepEqual(readAccountNativeAuth(fs, f.home, target), {});
});

test('ambiguous JSON key collision refuses migration, not last-write-wins data loss', t => {
  const f = fixture(t), target = f.plan().entries[0].new_account_ref;
  writeJsonValue(fs, f.home, 'fixture:collision', { [f.ref]: 'old', [target]: 'new' });
  assert.equal(ledgerIsApplicable(f.plan()).applicable, false);
});
