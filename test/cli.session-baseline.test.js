const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAccountStateIndex } = require('../lib/account/state-index');

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

test('`aih ls` is read-only and does not create profile directories', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const result = runCli(['ls'], homeDir);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);

  const aiHomeDir = path.join(homeDir, '.ai_home');
  assert.equal(fs.existsSync(aiHomeDir), false, 'read-only list command should not create ~/.ai_home');
});

test('`set-default` updates default pointer, syncs host auth, and drops profile-owned shared codex entries', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const toolDir = path.join(homeDir, '.ai_home', 'profiles', 'codex');
  const accountDir = path.join(toolDir, '1');
  const sandboxConfigDir = path.join(accountDir, '.codex');
  const sandboxSessionsDir = path.join(sandboxConfigDir, 'sessions');
  const sandboxAuthPath = path.join(sandboxConfigDir, 'auth.json');
  const sandboxConfigPath = path.join(sandboxConfigDir, 'config.toml');
  fs.mkdirSync(sandboxSessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sandboxSessionsDir, 'local-session.json'), '{"local":true}\n');
  fs.writeFileSync(sandboxAuthPath, '{"sandbox":"auth"}\n');
  fs.writeFileSync(sandboxConfigPath, 'model = "gpt-5"\n');

  const globalCodexDir = path.join(homeDir, '.codex');
  fs.mkdirSync(globalCodexDir, { recursive: true });
  fs.writeFileSync(path.join(globalCodexDir, 'history.jsonl'), '{"global":true}\n');

  const result = runCli(['codex', 'set-default', '1'], homeDir);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);

  const defaultPath = path.join(toolDir, '.aih_default');
  assert.equal(fs.readFileSync(defaultPath, 'utf8').trim(), '1');

  assert.equal(
    fs.existsSync(path.join(globalCodexDir, 'sessions')),
    false,
    'set-default should not backfill missing host shared session state from sandbox-owned files'
  );
  assert.equal(
    fs.existsSync(sandboxSessionsDir),
    false,
    'set-default should drop sandbox-owned shared session state when host source is absent'
  );
  assert.equal(
    fs.existsSync(path.join(globalCodexDir, 'history.jsonl')),
    true,
    'native global codex topology should remain untouched'
  );
  assert.equal(
    fs.readFileSync(path.join(globalCodexDir, 'auth.json'), 'utf8'),
    '{"sandbox":"auth"}\n',
    'set-default should sync selected account auth into native global tool directory'
  );
  assert.equal(
    fs.existsSync(path.join(globalCodexDir, 'config.toml')),
    false,
    'set-default should not backfill missing host shared config from sandbox-owned files'
  );
  assert.equal(
    fs.existsSync(sandboxConfigPath),
    false,
    'set-default should drop sandbox-owned shared codex entries when host source is absent'
  );
});

test('`aih ls` ignores lock-like non-numeric entries under tool profile dir', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const codexToolDir = path.join(homeDir, '.ai_home', 'profiles', 'codex');
  const lockLikeDir = path.join(codexToolDir, '.aih_auto_pool.lock');
  const numericAccountDir = path.join(codexToolDir, '1', '.codex');
  fs.mkdirSync(lockLikeDir, { recursive: true });
  fs.mkdirSync(numericAccountDir, { recursive: true });

  const result = runCli(['ls'], homeDir);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(result.stdout.includes('Account ID: .aih_auto_pool.lock'), false);
  assert.equal(result.stdout.includes('Account ID: \x1b[36m1\x1b[0m'), true);
});

test('`aih ls` fast index view does not show synthetic Indexed account names', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const codexToolDir = path.join(homeDir, '.ai_home', 'profiles', 'codex');
  fs.mkdirSync(codexToolDir, { recursive: true });
  for (let i = 1; i <= 520; i += 1) {
    fs.mkdirSync(path.join(codexToolDir, String(i), '.codex'), { recursive: true });
  }
  fs.writeFileSync(
    path.join(codexToolDir, '2', '.aih_env.json'),
    JSON.stringify({ OPENAI_API_KEY: 'sk-test-api-key-0002' }),
    'utf8'
  );

  const index = createAccountStateIndex({
    aiHomeDir: path.join(homeDir, '.ai_home'),
    fs
  });
  index.upsertAccountState('codex', '1', { configured: true, apiKeyMode: false, exhausted: false, remainingPct: 100 });
  index.upsertAccountState('codex', '2', { configured: true, apiKeyMode: true, exhausted: false, remainingPct: 0 });

  const result = runCli(['ls'], homeDir);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(result.stdout.includes('(Indexed)'), false);
  assert.equal(result.stdout.includes('[⚠️ Duplicate of ID'), false);
  assert.equal(result.stdout.includes('[Remaining: API Key mode]'), true);
});
