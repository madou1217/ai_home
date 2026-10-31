'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountCredentials, writeAccountNativeAuth, readAccountNativeAuth } = require('../lib/server/account-credential-store');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { readNodeAccounts } = require('../lib/account/go-bridge/node-account-reader');
const { encryptZcodeCredentialValue, isEncryptedZcodeCredentialValue } = require('../lib/account/zcode-credential');
const {
  DOCUMENT_KIND,
  buildNativeExportDocument,
  importNativeAccounts,
  nativeExportFileName,
  parseNativeImportDocument
} = require('../lib/account/native-account-transfer');
const { buildWebExport } = require('../lib/server/webui-account-routes-export');

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-transfer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedApiKeyAccount(aiHomeDir, provider, key, status = 'up') {
  const env = provider === 'claude'
    ? { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }
    : { OPENAI_API_KEY: key, OPENAI_BASE_URL: 'https://api.openai.com/v1' };
  const registered = registerAccountIdentity(fs, aiHomeDir, {
    provider, identitySeed: `api_key:${provider}:${env.OPENAI_BASE_URL || env.ANTHROPIC_BASE_URL}:${encodeURIComponent(key)}`
  });
  writeAccountCredentials(fs, aiHomeDir, registered.accountRef, env);
  const index = createAccountStateIndex({ fs, aiHomeDir });
  index.upsertAccountState(registered.accountRef, provider, { status, configured: true, apiKeyMode: true });
  index.close();
  return registered;
}

test('export → import into an empty home is lossless and keeps refs and CLI numbers', (t) => {
  const source = home(t);
  const a = seedApiKeyAccount(source, 'codex', 'sk-test-aaaaaaaaaaaaaaaaaaaa');
  const b = seedApiKeyAccount(source, 'claude', 'sk-ant-test-bbbbbbbbbbbbbbbb', 'down');
  const built = buildNativeExportDocument({ fs, aiHomeDir: source, hostName: 'source-host' });
  assert.equal(built.document.kind, DOCUMENT_KIND);
  assert.equal(built.document.version, 1);
  assert.equal(built.exported, 2);

  const target = home(t);
  const first = importNativeAccounts({ fs, aiHomeDir: target, input: JSON.stringify(built.document) });
  assert.equal(first.ok, true);
  assert.deepEqual({ ...first.summary }, { total: 2, created: 2, updated: 0, unchanged: 0, invalid: 0, failed: 0 });

  const imported = new Map(readNodeAccounts(target, { fs }).accounts.map((account) => [account.accountRef, account]));
  for (const original of [a, b]) {
    const copy = imported.get(original.accountRef);
    assert.ok(copy, 'account ref preserved');
    assert.equal(copy.cliAccountId, original.cliAccountId, 'CLI number preserved');
  }
  assert.equal(imported.get(b.accountRef).status, 'down', 'disabled state preserved');
  const reExported = buildNativeExportDocument({ fs, aiHomeDir: target }).document.accounts;
  assert.deepEqual(
    reExported.map(({ provider, accountRef, cliAccountId, status, env, nativeAuth }) => ({ provider, accountRef, cliAccountId, status, env, nativeAuth })),
    built.document.accounts
  );
});

test('re-importing the same file never creates duplicates', (t) => {
  const source = home(t);
  seedApiKeyAccount(source, 'codex', 'sk-test-cccccccccccccccccccc');
  const doc = JSON.stringify(buildNativeExportDocument({ fs, aiHomeDir: source }).document);
  const target = home(t);
  importNativeAccounts({ fs, aiHomeDir: target, input: doc });
  const again = importNativeAccounts({ fs, aiHomeDir: target, input: doc });
  assert.equal(again.summary.created, 0);
  assert.equal(again.summary.unchanged, 1);
  assert.equal(readNodeAccounts(target, { fs }).accounts.length, 1);
  // 导回来源机器本身也一样。
  const self = importNativeAccounts({ fs, aiHomeDir: source, input: doc });
  assert.equal(self.summary.unchanged, 1);
});

test('a changed credential for the same identity updates the existing account', (t) => {
  const source = home(t);
  const account = seedApiKeyAccount(source, 'codex', 'sk-test-dddddddddddddddddddd');
  const doc = buildNativeExportDocument({ fs, aiHomeDir: source }).document;
  doc.accounts[0].env.OPENAI_WIRE_API = 'responses';
  const result = importNativeAccounts({ fs, aiHomeDir: source, input: JSON.stringify(doc) });
  assert.equal(result.summary.updated, 1);
  assert.equal(result.accounts[0].accountRef, account.accountRef);
});

test('single-account and provider-scoped export', (t) => {
  const source = home(t);
  const a = seedApiKeyAccount(source, 'codex', 'sk-test-eeeeeeeeeeeeeeeeeeee');
  seedApiKeyAccount(source, 'claude', 'sk-ant-test-ffffffffffffffff');
  const one = buildNativeExportDocument({ fs, aiHomeDir: source, accountRefs: [a.accountRef] });
  assert.equal(one.exported, 1);
  assert.equal(one.document.accounts[0].accountRef, a.accountRef);
  assert.match(nativeExportFileName({ accountRefs: [a.accountRef], accounts: one.document.accounts }), new RegExp(`^aih-account-codex-${a.accountRef}-\\d{4}-\\d{2}-\\d{2}\\.json$`));
  assert.equal(buildNativeExportDocument({ fs, aiHomeDir: source, providers: ['claude'] }).exported, 1);
  const missing = buildNativeExportDocument({ fs, aiHomeDir: source, accountRefs: ['acct_00000000000000000000'] });
  assert.deepEqual(missing.skipped.map((s) => s.reason), ['account_not_found']);
});

test('web export route: scope params, legacy formats rejected, unknown account 404', (t) => {
  const source = home(t);
  const a = seedApiKeyAccount(source, 'codex', 'sk-test-gggggggggggggggggggg');
  const url = (query) => new URL(`http://x/v0/webui/accounts/export${query}`);
  assert.equal(buildWebExport({ fs, aiHomeDir: source, url: url('') }).exported, 1);
  assert.equal(buildWebExport({ fs, aiHomeDir: source, url: url(`?accountRef=${a.accountRef}`) }).exported, 1);
  assert.equal(buildWebExport({ fs, aiHomeDir: source, url: url('?provider=claude') }).exported, 0);
  for (const legacy of ['cliproxyapi', 'antigravity', 'sub2api']) {
    assert.equal(buildWebExport({ fs, aiHomeDir: source, url: url(`?format=${legacy}`) }).error, 'unsupported_export_format');
  }
  assert.equal(buildWebExport({ fs, aiHomeDir: source, url: url('?accountRef=acct_00000000000000000000') }).error, 'account_not_found');
});

test('machine-bound zcode encryption is decrypted on export and re-encrypted locally on import', (t) => {
  const source = home(t);
  const subject = '4a1c9d2e-0000-4000-8000-000000000001';
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `${b64({ alg: 'none' })}.${b64({ user_id: subject, sub: subject })}.c2ln`;
  const userInfo = JSON.stringify({ user_id: subject, email: 'z@example.com' });
  const registered = registerAccountIdentity(fs, source, { provider: 'zcode', identitySeed: `oauth:zcode:${subject}` });
  writeAccountNativeAuth(fs, source, registered.accountRef, { credentials: {
    zcodejwttoken: encryptZcodeCredentialValue(jwt),
    'oauth:zai:user_info': encryptZcodeCredentialValue(userInfo)
  } });
  const doc = buildNativeExportDocument({ fs, aiHomeDir: source }).document;
  const exported = doc.accounts[0].nativeAuth.credentials;
  assert.equal(exported.zcodejwttoken, jwt, 'portable plaintext in the file');
  assert.ok(!Object.values(exported).some(isEncryptedZcodeCredentialValue));

  // 导回同一台（原本加密存储）：继续加密存储，内容等价。
  importNativeAccounts({ fs, aiHomeDir: source, input: JSON.stringify(doc) });
  const stored = readAccountNativeAuth(fs, source, registered.accountRef).credentials;
  assert.ok(isEncryptedZcodeCredentialValue(stored.zcodejwttoken));
});

test('only aih documents are accepted; other formats are rejected explicitly', () => {
  assert.equal(parseNativeImportDocument('not json').error, 'invalid_json');
  assert.equal(parseNativeImportDocument(JSON.stringify({ accounts: [{ email: 'a', refresh_token: 'x' }] })).error, 'unsupported_import_format');
  assert.equal(parseNativeImportDocument(JSON.stringify({ type: 'sub2api-data', accounts: [] })).error, 'unsupported_import_format');
  assert.equal(parseNativeImportDocument(JSON.stringify({ kind: DOCUMENT_KIND, version: 9, accounts: [] })).error, 'unsupported_document_version');
  assert.equal(parseNativeImportDocument(JSON.stringify({ provider: 'codex', env: { OPENAI_API_KEY: 'k' } })).accounts.length, 1);
});

test('records without a resolvable identity or credentials are reported, not guessed', (t) => {
  const target = home(t);
  const result = importNativeAccounts({ fs, aiHomeDir: target, input: JSON.stringify({ kind: DOCUMENT_KIND, version: 1, accounts: [
    { provider: 'codex', env: {}, nativeAuth: {} },
    { provider: 'not-a-provider', env: { X: '1' } },
    { provider: 'codex', nativeAuth: { garbage: true } }
  ] }) });
  assert.deepEqual(result.accounts.map((a) => a.reason), ['credentials_missing', 'unsupported_provider', 'identity_unresolvable']);
  assert.equal(readNodeAccounts(target, { fs }).accounts.length, 0);
});

test('CLI: aih export / aih <cli> export <n> / aih import round-trip through files', async (t) => {
  const source = home(t);
  const a = seedApiKeyAccount(source, 'codex', 'sk-test-hhhhhhhhhhhhhhhhhhhh');
  seedApiKeyAccount(source, 'claude', 'sk-ant-test-iiiiiiiiiiiiiiii');
  const { runBackupCommand } = require('../lib/cli/commands/backup/router');
  const out = home(t);
  const logs = [];
  const exits = [];
  const deps = (aiHomeDir) => ({
    fs, path, aiHomeDir,
    consoleImpl: { log: (line) => logs.push(line), error: (line) => logs.push(line) },
    processImpl: { exit: (code) => exits.push(code) }
  });
  const cwd = process.cwd();
  process.chdir(out);
  t.after(() => process.chdir(cwd));

  await runBackupCommand('export', ['export', '__provider__', 'codex', a.cliAccountId], deps(source));
  assert.equal(exits.pop(), 0);
  const single = fs.readdirSync(out).find((name) => name.startsWith('aih-account-codex-'));
  assert.ok(single);
  assert.equal(fs.statSync(path.join(out, single)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, single), 'utf8')).accounts.length, 1);

  await runBackupCommand('export', ['export', 'all.json'], deps(source));
  assert.equal(exits.pop(), 0);
  const target = home(t);
  await runBackupCommand('import', ['import', path.join(out, 'all.json')], deps(target));
  assert.equal(exits.pop(), 0);
  assert.equal(readNodeAccounts(target, { fs }).accounts.length, 2);

  // provider 作用域导入只取文件里该 provider 的账号。
  const scoped = home(t);
  await runBackupCommand('import', ['import', '__provider__', 'claude', path.join(out, 'all.json')], deps(scoped));
  assert.deepEqual(readNodeAccounts(scoped, { fs }).accounts.map((x) => x.provider), ['claude']);

  await runBackupCommand('export', ['export', 'codex:999'], deps(source));
  assert.equal(exits.pop(), 1, 'unknown selector fails');
});
