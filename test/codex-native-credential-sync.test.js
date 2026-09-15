'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { compareCodexCredentialSnapshots, inspectCodexCredential, timestampMs } = require('../lib/account/codex-credential-freshness');
const { createCodexNativeCredentialSync } = require('../lib/account/codex-native-credential-sync');
const { decodeJwtPayloadUnsafe } = require('../lib/account/codex-auth-metadata');
const NOW = 1800000000000;
function jwt(payload) { return `test.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.not-a-real-signature`; }
function auth(generation = 2, email = 'user@example.invalid', extra = {}) {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: jwt({ iat: NOW / 1000 - 1000 + generation * 100, exp: NOW / 1000 + 3600,
        'https://api.openai.com/profile': { email },
        'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-test' } }),
      refresh_token: `test-refresh-${email}-${generation}`,
      id_token: jwt({ email }),
      account_id: 'workspace-test'
    },
    last_refresh: new Date(NOW - 1000000 + generation * 100000).toISOString(),
    ...extra
  };
}
function identity(_provider, value) {
  const email = decodeJwtPayloadUnsafe(value && value.auth && value.auth.tokens && value.auth.tokens.id_token)?.email;
  return { kind: 'oauth', degraded: !email, identitySeed: email ? `oauth:codex:${email.toLowerCase()}` : '' };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, 'aih');
  const hostHomeDir = path.join(root, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.mkdirSync(path.join(hostHomeDir, '.codex'), { recursive: true });
  const records = new Map();
  let writes = 0;
  let race = null;
  function registerIdentity(_fs, _home, input) {
    const accountRef = 'acct_' + crypto.createHash('sha256').update(input.identitySeed).digest('hex').slice(0, 20);
    return { accountRef, created: !records.has(accountRef) };
  }
  const store = {
    listAccountCredentialRecords: () => structuredClone([...records.values()]),
    readAccountCredentialRecord: (_fs, _home, ref) => structuredClone(records.get(ref) || null),
    compareAndSwapAccountNativeAuth(_fs, _home, ref, snapshot, next) {
      if (race) { const action = race; race = null; action(ref); }
      const current = records.get(ref);
      if (JSON.stringify(current) !== JSON.stringify(snapshot)) return false;
      writes += 1;
      records.set(ref, { ...current, nativeAuth: structuredClone(next), nativeAuthUpdatedAt: current.nativeAuthUpdatedAt + 1 });
      return true;
    }
  };
  const insertIfMissing = (_fs, _home, ref, value) => {
    if (records.has(ref)) return false;
    writes += 1;
    records.set(ref, { accountRef: ref, provider: 'codex', env: {}, nativeAuth: structuredClone(value), nativeAuthUpdatedAt: NOW });
    return true;
  };
  function seed(value, timestamp = NOW + 10000, env = {}) {
    const ref = registerIdentity(null, null, { identitySeed: identity('codex', { auth: value }).identitySeed }).accountRef;
    records.set(ref, { accountRef: ref, provider: 'codex', env, nativeAuth: { auth: structuredClone(value), keep: true }, nativeAuthUpdatedAt: timestamp });
    return ref;
  }
  function write(value, target = path.join(hostHomeDir, '.codex', 'auth.json')) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value));
    return target;
  }
  function sync(extra = {}) {
    return createCodexNativeCredentialSync({ fs, aiHomeDir, hostHomeDir, now: () => NOW, store,
      resolveIdentity: identity, registerIdentity, insertIfMissing, ...extra });
  }
  return { root, aiHomeDir, hostHomeDir, records, seed, write, sync, writes: () => writes, race: fn => { race = fn; } };
}

test('newer credential generation wins even when the old DB was imported today', () => {
  assert.equal(compareCodexCredentialSnapshots(auth(1), auth(2), { nowMs: NOW }).adopt, true);
});
test('a later file/database timestamp cannot revive an older token', () => {
  assert.equal(compareCodexCredentialSnapshots(auth(3), auth(1), { nowMs: NOW, fileMtimeMs: NOW + 1e9 }).reason, 'older_token_issued_at');
});
test('last_refresh breaks a same-issued-second tie', () => {
  const a = auth(1); const b = auth(1, undefined, { last_refresh: new Date(NOW - 1000).toISOString() });
  b.tokens.refresh_token += '-rotated';
  assert.equal(compareCodexCredentialSnapshots(a, b, { nowMs: NOW }).reason, 'newer_last_refresh');
});
test('touching metadata without rotating credentials is a no-op', () => {
  const a = auth(1); const b = { ...a, last_refresh: new Date(NOW).toISOString() };
  assert.equal(compareCodexCredentialSnapshots(a, b, { nowMs: NOW }).reason, 'unchanged');
});
test('expiry duration is not evidence of a newer generation', () => {
  const a = auth(3); const b = auth(1);
  const payload = decodeJwtPayloadUnsafe(b.tokens.access_token); payload.exp += 999999;
  b.tokens.access_token = jwt(payload);
  assert.equal(compareCodexCredentialSnapshots(a, b, { nowMs: NOW }).adopt, false);
});
test('different credentials with equal clocks are a conflict, not last-writer-wins', () => {
  const a = auth(2); const b = auth(2); b.tokens.refresh_token = 'test-other-grant';
  assert.equal(compareCodexCredentialSnapshots(a, b, { nowMs: NOW }).reason, 'credential_time_ambiguous');
});
test('future timestamps cannot take over a current account', () => {
  const b = auth(2, undefined, { last_refresh: new Date(NOW + 900000).toISOString() });
  assert.equal(inspectCodexCredential(b, NOW).reason, 'future_credential_timestamp');
});
test('partial auth cannot destroy a working refresh grant', () => {
  const b = auth(2); delete b.tokens.refresh_token;
  assert.equal(compareCodexCredentialSnapshots(auth(1), b, { nowMs: NOW }).reason, 'incomplete_credentials');
});
test('API-key stubs are not OAuth observations', () => {
  assert.equal(inspectCodexCredential({ ...auth(2), OPENAI_API_KEY: 'test-key' }, NOW).reason, 'not_oauth');
});
test('internally mismatched account claims are rejected', () => {
  const b = auth(2); b.tokens.account_id = 'different';
  assert.equal(inspectCodexCredential(b, NOW).reason, 'inconsistent_identity_claims');
});
test('timestamp parser handles ISO, epoch seconds and epoch milliseconds', () => {
  for (const value of [NOW, String(NOW), NOW / 1000, new Date(NOW).toISOString()]) assert.equal(timestampMs(value), NOW);
  for (const value of ['yesterday', {}, '', -1, Infinity]) assert.equal(timestampMs(value), 0);
});
test('an independent App login updates the corresponding record without set-default', t => {
  const f = fixture(t); const ref = f.seed(auth(1)); f.write(auth(2));
  const result = f.sync().scan();
  assert.equal(result.updated[0].accountRef, ref);
  assert.deepEqual(f.records.get(ref).nativeAuth.auth, auth(2));
  assert.equal(f.records.get(ref).nativeAuth.keep, true);
});
test('an unrelated native login is registered separately instead of overwriting the old account', t => {
  const f = fixture(t); const old = f.seed(auth(1)); f.write(auth(2, 'new@example.invalid'));
  const result = f.sync().scan();
  assert.notEqual(result.updated[0].accountRef, old);
  assert.deepEqual(f.records.get(old).nativeAuth.auth, auth(1));
  assert.equal(f.records.size, 2);
});
test('native import never writes config, defaults, auth files, or session metadata', t => {
  const f = fixture(t); f.seed(auth(1)); const source = f.write(auth(2));
  const config = path.join(f.hostHomeDir, '.codex', 'config.toml'); fs.writeFileSync(config, 'keep exact\n');
  const before = fs.readFileSync(source); f.sync().scan();
  assert.deepEqual(fs.readFileSync(source), before); assert.equal(fs.readFileSync(config, 'utf8'), 'keep exact\n');
});
test('repeated scans do not bump database timestamps or rewrite unchanged grants', t => {
  const f = fixture(t); f.seed(auth(1)); f.write(auth(2)); const sync = f.sync();
  sync.scan(); const writes = f.writes();
  for (let i = 0; i < 20; i += 1) sync.scan();
  assert.equal(f.writes(), writes);
});
test('restoring a stale backup with fresh mtime cannot regress DB credentials', t => {
  const f = fixture(t); const ref = f.seed(auth(3)); const file = f.write(auth(1));
  fs.utimesSync(file, new Date(NOW + 10000), new Date(NOW + 10000));
  assert.equal(f.sync().scan().updated.length, 0); assert.deepEqual(f.records.get(ref).nativeAuth.auth, auth(3));
});
test('backup files and arbitrary subdirectories are never imported', t => {
  const f = fixture(t); f.write(auth(2), path.join(f.hostHomeDir, '.codex', 'auth.json.bak'));
  f.write(auth(2), path.join(f.hostHomeDir, 'unrelated', 'auth.json'));
  assert.equal(f.sync().scan().updated.length, 0); assert.equal(f.records.size, 0);
});
test('truncated file is retried after the App finishes writing', t => {
  const f = fixture(t); const ref = f.seed(auth(1)); const source = path.join(f.hostHomeDir, '.codex', 'auth.json');
  fs.writeFileSync(source, '{"tokens":'); const sync = f.sync();
  assert.equal(sync.scan().updated.length, 0); f.write(auth(2));
  assert.equal(sync.scan().updated[0].accountRef, ref);
});
test('deleted native auth is not a request to delete stored accounts', t => {
  const f = fixture(t); const ref = f.seed(auth(1)); const source = f.write(auth(2)); const sync = f.sync();
  sync.scan(); fs.unlinkSync(source); sync.scan();
  assert.deepEqual(f.records.get(ref).nativeAuth.auth, auth(2));
});
test('competing newer DB write is protected by compare-and-swap and re-evaluation', t => {
  const f = fixture(t); const ref = f.seed(auth(1)); f.write(auth(2));
  f.race(() => { f.records.get(ref).nativeAuth.auth = auth(3); f.records.get(ref).nativeAuthUpdatedAt += 1; });
  assert.equal(f.sync().scan().updated.length, 0); assert.deepEqual(f.records.get(ref).nativeAuth.auth, auth(3));
});
test('a metadata-only concurrent write is preserved when retrying a newer grant', t => {
  const f = fixture(t); const ref = f.seed(auth(1)); f.write(auth(2));
  f.race(() => { f.records.get(ref).nativeAuth.label = 'keep concurrent'; f.records.get(ref).nativeAuthUpdatedAt += 1; });
  assert.equal(f.sync().scan().updated.length, 1);
  assert.equal(f.records.get(ref).nativeAuth.label, 'keep concurrent');
});
test('known desktop runtime auth is observed, without trusting its directory name as identity', t => {
  const f = fixture(t); const ref = f.seed(auth(1));
  f.write(auth(2, 'different@example.invalid'), path.join(f.aiHomeDir, 'run', 'codex-desktop', ref, 'auth.json'));
  const result = f.sync().scan(); assert.notEqual(result.updated[0].accountRef, ref);
  assert.deepEqual(f.records.get(ref).nativeAuth.auth, auth(1));
});
test('an older managed projection cannot undo a newer host login in the same scan', t => {
  const f = fixture(t); const ref = f.seed(auth(1)); f.write(auth(3));
  f.write(auth(2), path.join(f.aiHomeDir, 'run', 'codex-desktop', ref, 'auth.json'));
  f.sync().scan(); assert.deepEqual(f.records.get(ref).nativeAuth.auth, auth(3));
});
test('symlink auth sources are not followed into unrelated files', t => {
  const f = fixture(t); const source = f.write(auth(2), path.join(f.root, 'outside.json'));
  fs.symlinkSync(source, path.join(f.hostHomeDir, '.codex', 'auth.json'));
  assert.equal(f.sync().scan().updated.length, 0);
});
test('polling starts with a scan and retries failed runtime notifications', t => {
  const f = fixture(t); f.seed(auth(1)); f.write(auth(2)); let tick; let stopped = 0; let calls = 0;
  const sync = f.sync({ setInterval: cb => { tick = cb; return { unref() {} }; }, clearInterval: () => { stopped += 1; } });
  sync.start({ onUpdated() { calls += 1; if (calls === 1) throw new Error('retry'); } });
  assert.equal(sync.getStats().pending, 1); tick(); assert.equal(sync.getStats().pending, 0);
  sync.stop(); tick(); assert.equal(stopped, 1); assert.equal(calls, 2);
});
test('diagnostics contain neither tokens nor email addresses', t => {
  const f = fixture(t); f.seed(auth(1)); f.write(auth(2)); const sync = f.sync();
  const text = JSON.stringify({ result: sync.scan(), stats: sync.getStats() });
  assert.doesNotMatch(text, /test-refresh|access_token|user@example|not-a-real-signature/);
});
