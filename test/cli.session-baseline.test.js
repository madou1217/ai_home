const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { getAihProviderKey } = require('../lib/cli/services/pty/codex-config-sync');

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

test('`set-default` updates default pointer, migrates shared codex state to host, and keeps account-owned codex config isolated', (t) => {
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
    true,
    'set-default should migrate sandbox-owned shared session state into host storage'
  );
  assert.equal(
    fs.lstatSync(sandboxSessionsDir).isSymbolicLink(),
    true,
    'set-default should relink sandbox shared session state back to host storage'
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
    'set-default should keep account-owned codex config isolated'
  );
  assert.equal(
    fs.existsSync(sandboxConfigPath),
    true,
    'set-default should preserve account-owned codex config instead of deleting it as shared state'
  );
  assert.equal(fs.readFileSync(sandboxConfigPath, 'utf8'), 'model = "gpt-5"\n');
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

test('`aih codex set-default` writes managed api-key provider config into host codex config', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const toolDir = path.join(homeDir, '.ai_home', 'profiles', 'codex');
  const accountDir = path.join(toolDir, '10');
  const sandboxConfigDir = path.join(accountDir, '.codex');
  fs.mkdirSync(sandboxConfigDir, { recursive: true });
  fs.writeFileSync(path.join(sandboxConfigDir, 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: 'dummy'
  }, null, 2));

  const result = runCli(['codex', 'set-default', '10'], homeDir);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);

  const hostConfigPath = path.join(homeDir, '.codex', 'config.toml');
  assert.equal(fs.existsSync(hostConfigPath), true);

  const hostConfig = fs.readFileSync(hostConfigPath, 'utf8');
  const providerKey = getAihProviderKey('10');
  assert.match(hostConfig, /^preferred_auth_method = "apikey"/m);
  assert.match(hostConfig, new RegExp(`^model_provider = "${providerKey}"$`, 'm'));
  assert.match(hostConfig, new RegExp(`^\\[model_providers\\.${providerKey}\\]$`, 'm'));
  assert.match(hostConfig, /^base_url = "http:\/\/127\.0\.0\.1:8317\/v1"$/m);
  assert.match(hostConfig, /^bearer_token = "dummy"$/m);
});

test('`aih codex set-default` keeps prior account provider blocks and switches model_provider to the selected account', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const toolDir = path.join(homeDir, '.ai_home', 'profiles', 'codex');
  const account10Dir = path.join(toolDir, '10', '.codex');
  const account11Dir = path.join(toolDir, '11', '.codex');
  fs.mkdirSync(account10Dir, { recursive: true });
  fs.mkdirSync(account11Dir, { recursive: true });

  fs.writeFileSync(path.join(account10Dir, 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: 'dummy-10'
  }, null, 2));
  fs.writeFileSync(path.join(toolDir, '10', '.aih_env.json'), JSON.stringify({
    OPENAI_API_KEY: 'dummy-10'
  }, null, 2));

  fs.writeFileSync(path.join(account11Dir, 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: 'dummy-11'
  }, null, 2));
  fs.writeFileSync(path.join(toolDir, '11', '.aih_env.json'), JSON.stringify({
    OPENAI_API_KEY: 'dummy-11',
    OPENAI_BASE_URL: 'https://b.example.com/v1'
  }, null, 2));

  const firstResult = runCli(['codex', 'set-default', '10'], homeDir);
  assert.equal(firstResult.status, 0, `stdout=${firstResult.stdout}\nstderr=${firstResult.stderr}`);

  const secondResult = runCli(['codex', 'set-default', '11'], homeDir);
  assert.equal(secondResult.status, 0, `stdout=${secondResult.stdout}\nstderr=${secondResult.stderr}`);

  const hostConfigPath = path.join(homeDir, '.codex', 'config.toml');
  const hostConfig = fs.readFileSync(hostConfigPath, 'utf8');
  const provider10 = getAihProviderKey('10');
  const provider11 = getAihProviderKey('11');

  assert.match(hostConfig, new RegExp(`^model_provider = "${provider11}"$`, 'm'));
  assert.match(hostConfig, new RegExp(`\\[model_providers\\.${provider10}\\][\\s\\S]*?base_url = "http://127\\.0\\.0\\.1:8317/v1"[\\s\\S]*?bearer_token = "dummy"`));
  assert.match(hostConfig, new RegExp(`\\[model_providers\\.${provider11}\\][\\s\\S]*?base_url = "https://b\\.example\\.com/v1"[\\s\\S]*?bearer_token = "dummy-11"`));
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
  index.upsertAccountState('codex', '1', { configured: true, apiKeyMode: false, remainingPct: 100 });
  index.upsertAccountState('codex', '2', { configured: true, apiKeyMode: true, remainingPct: 0 });

  const result = runCli(['ls'], homeDir);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(result.stdout.includes('(Indexed)'), false);
  assert.equal(result.stdout.includes('[⚠️ Duplicate of ID'), false);
  assert.equal(result.stdout.includes('[Remaining: API Key mode]'), true);
});
