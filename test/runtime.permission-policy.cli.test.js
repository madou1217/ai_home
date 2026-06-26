const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-policy-cli-'));
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

function readPolicy(hostHomeDir) {
  const policyPath = path.join(hostHomeDir, '.ai_home', 'policy', 'exec-permission-policy.json');
  return JSON.parse(fs.readFileSync(policyPath, 'utf8'));
}

test('`aih codex policy` shows default workspace-write policy when file is missing', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const result = runCli(['codex', 'policy'], homeDir);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /default_sandbox:\s+workspace-write/);
  assert.match(result.stdout, /allow_danger_full_access:\s+false/);
});

test('`aih codex policy set` persists and reuses the selected sandbox policy', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const setDanger = runCli(['codex', 'policy', 'set', 'danger-full-access'], homeDir);
  assert.equal(setDanger.status, 0, `stdout=${setDanger.stdout}\nstderr=${setDanger.stderr}`);

  const policyAfterDanger = readPolicy(homeDir);
  assert.equal(policyAfterDanger.exec.defaultSandbox, 'danger-full-access');
  assert.equal(policyAfterDanger.exec.allowDangerFullAccess, true);

  const setReadOnly = runCli(['codex', 'policy', 'set', 'read-only'], homeDir);
  assert.equal(setReadOnly.status, 0, `stdout=${setReadOnly.stdout}\nstderr=${setReadOnly.stderr}`);

  const policyAfterReadOnly = readPolicy(homeDir);
  assert.equal(policyAfterReadOnly.exec.defaultSandbox, 'read-only');
  assert.equal(policyAfterReadOnly.exec.allowDangerFullAccess, false);

  const show = runCli(['codex', 'policy'], homeDir);
  assert.equal(show.status, 0, `stdout=${show.stdout}\nstderr=${show.stderr}`);
  assert.match(show.stdout, /default_sandbox:\s+read-only/);
  assert.match(show.stdout, /effective_exec_sandbox:\s+read-only/);
});
