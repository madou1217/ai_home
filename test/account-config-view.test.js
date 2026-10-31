'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { readAccountConfigFiles } = require('../lib/account/account-config-view');
const { handleWebUiAccountConfigViewRoutes } = require('../lib/server/webui-account-config-view-routes');

function makeKiroDatabaseBase64(dir) {
  const file = path.join(dir, 'seed.sqlite3');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB)');
  db.exec('CREATE TABLE history (id INTEGER)');
  db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run('kirocli:social:token', JSON.stringify({
    access_token: 'AT-SECRET',
    refresh_token: 'RT-SECRET',
    provider: 'google',
    region: 'us-east-1'
  }));
  db.prepare('INSERT INTO state VALUES (?, ?)').run(
    'api.codewhisperer.profile',
    Buffer.from(JSON.stringify({ arn: 'arn:aws:codewhisperer:profile/X', profile_name: 'Default' }))
  );
  db.close();
  const base64 = fs.readFileSync(file).toString('base64');
  fs.rmSync(file);
  return base64;
}

function setup() {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-config-view-'));
  const accountRef = upsertAccountRef(fs, aiHomeDir, { provider: 'kiro', cliAccountId: '1', identitySeed: 'kiro:test-user' });
  assert.ok(accountRef);
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    database: makeKiroDatabaseBase64(aiHomeDir),
    auth: { access_token: 'AT-SECRET', refresh_token: 'RT-SECRET', region: 'us-east-1' },
    flavor: 'desktop'
  });
  const runtimeDir = path.join(aiHomeDir, 'projection', accountRef);
  fs.mkdirSync(path.join(runtimeDir, '.kiro', 'settings'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, '.kiro', 'settings', 'cli.json'), '{"chat.defaultModel":"claude"}');
  fs.writeFileSync(path.join(runtimeDir, 'unrelated.txt'), 'should not be listed');
  fs.writeFileSync(path.join(runtimeDir, '.aih-kiro-auth-binding'), `${'a1b2c3d4'.repeat(8)}\n`);
  return {
    aiHomeDir,
    accountRef,
    runtimeDir,
    getProfileDir: () => runtimeDir,
    cleanup: () => fs.rmSync(aiHomeDir, { recursive: true, force: true })
  };
}

test('kiro account config: redacted by default, decodes embedded sqlite, lists only declared projection files', (t) => {
  const env = setup();
  t.after(env.cleanup);
  const result = readAccountConfigFiles('kiro', env.accountRef, {
    fs, aiHomeDir: env.aiHomeDir, getProfileDir: env.getProfileDir
  });
  const ids = result.files.map((file) => file.id);
  assert.deepEqual(ids, [
    'store:credentials',
    'store:database',
    'projection:.kiro/settings/cli.json',
    'projection:.aih-kiro-auth-binding'
  ]);
  assert.equal(result.files[3].content, '<redacted>\n');
  const all = result.files.map((file) => file.content).join('\n');
  assert.ok(!all.includes('AT-SECRET'));
  assert.ok(!all.includes('RT-SECRET'));
  assert.ok(!all.includes('unrelated'));

  const store = JSON.parse(result.files[0].content);
  assert.match(store.nativeAuth.database, /^<sqlite \d+ 字节/);
  assert.equal(store.nativeAuth.auth.region, 'us-east-1');

  const database = JSON.parse(result.files[1].content);
  assert.equal(database.auth_kv['kirocli:social:token'].access_token, '<redacted>');
  assert.equal(database.auth_kv['kirocli:social:token'].provider, 'google');
  assert.equal(database.state['api.codewhisperer.profile'].profile_name, 'Default');
  assert.deepEqual(database.history, { '<rows>': 0 });

  assert.equal(JSON.parse(result.files[2].content)['chat.defaultModel'], 'claude');
});

test('kiro account config: raw mode returns secrets verbatim', (t) => {
  const env = setup();
  t.after(env.cleanup);
  const result = readAccountConfigFiles('kiro', env.accountRef, {
    fs, aiHomeDir: env.aiHomeDir, getProfileDir: env.getProfileDir, mode: 'raw'
  });
  assert.equal(result.mode, 'raw');
  const database = JSON.parse(result.files.find((file) => file.id === 'store:database').content);
  assert.equal(database.auth_kv['kirocli:social:token'].access_token, 'AT-SECRET');
});

test('host-home profile dir (gateway providers) is never exposed as account projection', (t) => {
  const env = setup();
  t.after(env.cleanup);
  const result = readAccountConfigFiles('kiro', env.accountRef, {
    fs, aiHomeDir: env.aiHomeDir, getProfileDir: env.getProfileDir, hostHomeDir: env.runtimeDir
  });
  assert.equal(result.runtimeDirExists, false);
  assert.ok(result.files.every((file) => file.source === 'store'));
});

function callRoute(env, pathname, method = 'GET') {
  const captured = {};
  const ctx = {
    method,
    pathname,
    url: new URL(`http://x${pathname}`),
    fs,
    aiHomeDir: env.aiHomeDir,
    getProfileDir: env.getProfileDir,
    res: { setHeader() {} },
    writeJson: (_res, status, body) => { captured.status = status; captured.body = body; }
  };
  return handleWebUiAccountConfigViewRoutes(ctx).then((handled) => ({ handled, ...captured }));
}

test('route: 200 for the right provider, 404 for mismatched provider, 405 for non-GET, ignores other paths', async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const ok = await callRoute(env, `/v0/webui/accounts/kiro/${env.accountRef}/config-files`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.files.length, 4);
  const mismatch = await callRoute(env, `/v0/webui/accounts/codex/${env.accountRef}/config-files`);
  assert.equal(mismatch.status, 404);
  const post = await callRoute(env, `/v0/webui/accounts/kiro/${env.accountRef}/config-files`, 'POST');
  assert.equal(post.status, 405);
  const other = await callRoute(env, `/v0/webui/accounts/kiro/${env.accountRef}/status`);
  assert.equal(other.handled, false);
});
