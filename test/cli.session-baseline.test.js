'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const { readDefaultAccountRef } = require('../lib/account/default-account-store');
const { createAccountStateIndex } = require('../lib/account/state-index');
const {
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const {
  AIH_CODEX_PROVIDER_BASE_URL,
  getAihProviderKey
} = require('../lib/cli/services/pty/codex-config-sync');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');

const REPO_ROOT = path.resolve(__dirname, '..');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cli-baseline-'));
}

function runCli(args, hostHomeDir) {
  return spawnSync(process.execPath, ['bin/ai-home.js', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AIH_HOST_HOME: hostHomeDir,
      HOME: hostHomeDir
    },
    encoding: 'utf8'
  });
}

function registerTestAccount(homeDir, provider, cliAccountId, data = {}) {
  const aiHomeDir = path.join(homeDir, '.ai_home');
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed: `cli-baseline:${provider}:${cliAccountId}@example.com`
  });
  if (data.env) {
    writeAccountCredentials(fs, aiHomeDir, registration.accountRef, data.env);
  }
  if (data.nativeAuth) {
    writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, data.nativeAuth);
  }
  return {
    aiHomeDir,
    accountRef: registration.accountRef,
    runtimeDir: resolveAccountRuntimeDir(aiHomeDir, provider, registration.accountRef)
  };
}

function encodedWindowsCodexHomeEntry() {
  const colon = String.fromCharCode(0xf03a);
  const backslash = String.fromCharCode(0xf05c);
  return `C${colon}${backslash}Users${backslash}madou${backslash}.codex`;
}

test('`aih ls` is read-only and does not create app-state storage', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const result = runCli(['ls'], homeDir);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(fs.existsSync(path.join(homeDir, '.ai_home')), false);
});

test('`set-default` stores accountRef, migrates shared Codex state, and syncs DB auth', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const account = registerTestAccount(homeDir, 'codex', '1', {
    nativeAuth: { auth: { sandbox: 'auth' } }
  });
  const sandboxConfigDir = path.join(account.runtimeDir, '.codex');
  const sandboxSessionsDir = path.join(sandboxConfigDir, 'sessions');
  const sandboxConfigPath = path.join(sandboxConfigDir, 'config.toml');
  fs.mkdirSync(sandboxSessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sandboxSessionsDir, 'local-session.json'), '{"local":true}\n');
  fs.writeFileSync(sandboxConfigPath, 'model = "gpt-5"\n');

  const globalCodexDir = path.join(homeDir, '.codex');
  fs.mkdirSync(globalCodexDir, { recursive: true });
  fs.writeFileSync(path.join(globalCodexDir, 'history.jsonl'), '{"global":true}\n');

  const result = runCli(['codex', 'set-default', '1'], homeDir);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(readDefaultAccountRef(fs, account.aiHomeDir, 'codex'), account.accountRef);
  assert.equal(fs.existsSync(path.join(globalCodexDir, 'sessions')), true);
  assert.equal(fs.lstatSync(sandboxSessionsDir).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(globalCodexDir, 'history.jsonl')), true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(globalCodexDir, 'auth.json'), 'utf8')),
    { sandbox: 'auth' }
  );

  fs.writeFileSync(path.join(sandboxConfigDir, 'auth.json'), '{"sandbox":"runtime-only"}\n');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(globalCodexDir, 'auth.json'), 'utf8')),
    { sandbox: 'auth' }
  );

  const hostConfig = fs.readFileSync(path.join(globalCodexDir, 'config.toml'), 'utf8');
  assert.match(hostConfig, /^preferred_auth_method = "oauth"$/m);
  assert.match(hostConfig, /^model_provider = "openai"$/m);
  assert.equal(fs.readFileSync(sandboxConfigPath, 'utf8'), 'model = "gpt-5"\n');
});

test('`set-default` does not migrate encoded Windows absolute path entries', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const account = registerTestAccount(homeDir, 'codex', '1', {
    nativeAuth: { auth: { sandbox: 'auth' } }
  });
  const accountCodexDir = path.join(account.runtimeDir, '.codex');
  const encodedEntry = encodedWindowsCodexHomeEntry();
  fs.mkdirSync(path.join(accountCodexDir, encodedEntry), { recursive: true });
  fs.writeFileSync(path.join(accountCodexDir, encodedEntry, 'state.json'), '{"bad":true}\n');

  const result = runCli(['codex', 'set-default', '1'], homeDir);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(fs.existsSync(path.join(homeDir, '.codex', encodedEntry)), false);
  assert.equal(fs.existsSync(path.join(accountCodexDir, encodedEntry)), true);
});

test('`aih ls` lists registered accounts and ignores runtime-only entries', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const account = registerTestAccount(homeDir, 'codex', '1', {
    nativeAuth: { auth: { tokens: { access_token: 'codex-access-token' } } }
  });
  fs.mkdirSync(path.join(account.aiHomeDir, 'run', 'auth-projections', 'codex', '.aih_auto_pool.lock'), { recursive: true });
  fs.mkdirSync(path.join(account.aiHomeDir, 'run', 'auth-projections', 'codex', 'acct_00000000000000000000'), { recursive: true });

  const result = runCli(['ls'], homeDir);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(result.stdout.includes('Account ID: .aih_auto_pool.lock'), false);
  assert.equal(result.stdout.includes('acct_00000000000000000000'), false);
  assert.equal(result.stdout.includes('Account ID: \x1b[36m1\x1b[0m'), true);
});

test('`aih codex set-default` writes canonical API-key provider config', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  registerTestAccount(homeDir, 'codex', '10', {
    env: { OPENAI_API_KEY: 'dummy' }
  });

  const result = runCli(['codex', 'set-default', '10'], homeDir);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  const hostConfig = fs.readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8');
  const providerKey = getAihProviderKey();
  assert.match(hostConfig, /^preferred_auth_method = "apikey"/m);
  assert.match(hostConfig, new RegExp(`^model_provider = "${providerKey}"$`, 'm'));
  assert.match(hostConfig, new RegExp(`^\\[model_providers\\.${providerKey}\\]$`, 'm'));
  assert.match(hostConfig, new RegExp(`^base_url = "${AIH_CODEX_PROVIDER_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'));
  assert.match(hostConfig, /^bearer_token = "dummy"$/m);
});

test('switching API-key defaults updates one canonical provider block', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  registerTestAccount(homeDir, 'codex', '10', {
    env: { OPENAI_API_KEY: 'dummy-10' }
  });
  registerTestAccount(homeDir, 'codex', '11', {
    env: {
      OPENAI_API_KEY: 'dummy-11',
      OPENAI_BASE_URL: 'https://b.example.com/v1'
    }
  });

  const firstResult = runCli(['codex', 'set-default', '10'], homeDir);
  assert.equal(firstResult.status, 0, `stdout=${firstResult.stdout}\nstderr=${firstResult.stderr}`);
  const secondResult = runCli(['codex', 'set-default', '11'], homeDir);
  assert.equal(secondResult.status, 0, `stdout=${secondResult.stdout}\nstderr=${secondResult.stderr}`);

  const hostConfig = fs.readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8');
  const providerKey = getAihProviderKey();
  assert.equal((hostConfig.match(new RegExp(`^\\[model_providers\\.${providerKey}\\]$`, 'gm')) || []).length, 1);
  assert.match(hostConfig, /^base_url = "https:\/\/b\.example\.com\/v1"$/m);
  assert.match(hostConfig, /^env_key = "OPENAI_API_KEY"$/m);
  assert.doesNotMatch(hostConfig, /dummy-(10|11)/);
});

test('`aih ls` renders DB-backed status without synthetic account names', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const oauth = registerTestAccount(homeDir, 'codex', '1', {
    nativeAuth: { auth: { tokens: { access_token: 'codex-access-token' } } }
  });
  const apiKey = registerTestAccount(homeDir, 'codex', '2', {
    env: { OPENAI_API_KEY: 'sk-test-api-key-0002' }
  });
  const index = createAccountStateIndex({ aiHomeDir: oauth.aiHomeDir, fs });
  index.upsertAccountState(oauth.accountRef, 'codex', {
    configured: true,
    apiKeyMode: false,
    remainingPct: 100
  });
  index.upsertAccountState(apiKey.accountRef, 'codex', {
    configured: true,
    apiKeyMode: true,
    remainingPct: 0
  });

  const result = runCli(['ls'], homeDir);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(result.stdout.includes('(Indexed)'), false);
  assert.equal(result.stdout.includes('[Remaining: API Key mode]'), true);
});
