const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'cleanup-codex-free-accounts.js');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cleanup-codex-'));
}

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function runScript(args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
}

test('cleanup script dry-run selects auth-failed and long-reset free codex accounts and matching cliproxyapi auths', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homeDir = path.join(root, 'home');
  const profilesDir = path.join(homeDir, '.ai_home', 'profiles', 'codex');
  const clipAuthDir = path.join(root, 'clip-auths');

  fs.mkdirSync(path.join(profilesDir, '1', '.codex'), { recursive: true });
  writeJson(path.join(profilesDir, '1', '.codex', 'auth.json'), { broken: true });

  writeJson(path.join(profilesDir, '2', '.codex', 'auth.json'), {
    tokens: {
      id_token: makeJwt({ email: 'free@example.com' }),
      access_token: makeJwt({ email: 'free@example.com' }),
      refresh_token: 'rt_free',
      account_id: 'acct-free'
    }
  });
  writeJson(path.join(profilesDir, '2', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '7days', remainingPct: 0, resetAtMs: Date.now() + (6 * 24 * 60 * 60 * 1000) }]
  });

  writeJson(path.join(profilesDir, '3', '.aih_env.json'), { OPENAI_API_KEY: 'sk-test' });
  writeJson(path.join(profilesDir, '3', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '7days', remainingPct: 0, resetAtMs: Date.now() + (8 * 24 * 60 * 60 * 1000) }]
  });

  writeJson(path.join(profilesDir, '4', '.codex', 'auth.json'), {
    tokens: {
      id_token: makeJwt({ email: 'short@example.com' }),
      access_token: makeJwt({ email: 'short@example.com' }),
      refresh_token: 'rt_short',
      account_id: 'acct-short'
    }
  });
  writeJson(path.join(profilesDir, '4', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 0, resetAtMs: Date.now() + (4 * 60 * 60 * 1000) }]
  });

  writeJson(path.join(clipAuthDir, 'free@example.com.json'), {
    type: 'codex',
    email: 'free@example.com',
    refresh_token: 'rt_free',
    account_id: 'acct-free'
  });
  writeJson(path.join(clipAuthDir, 'other@example.com.json'), {
    type: 'codex',
    email: 'other@example.com',
    refresh_token: 'rt_other',
    account_id: 'acct-other'
  });

  const result = runScript(['--home', homeDir, '--cliproxyapi-auth-dir', clipAuthDir, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  assert.deepEqual(payload.candidates.map((item) => item.id), ['1', '2']);
  assert.equal(payload.candidates[0].reasons.includes('auth_failed'), true);
  assert.equal(payload.candidates[1].reasons.includes('remaining_0_reset_gt_5d'), true);
  assert.deepEqual(payload.cliproxyapiMatches, [path.join(clipAuthDir, 'free@example.com.json')]);
  assert.equal(fs.existsSync(path.join(profilesDir, '2')), true);
  assert.equal(fs.existsSync(path.join(clipAuthDir, 'free@example.com.json')), true);
});

test('cleanup script apply removes selected codex profiles and matching cliproxyapi auths', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homeDir = path.join(root, 'home');
  const profilesDir = path.join(homeDir, '.ai_home', 'profiles', 'codex');
  const clipAuthDir = path.join(root, 'clip-auths');

  writeJson(path.join(profilesDir, '7', '.codex', 'auth.json'), {
    tokens: {
      id_token: makeJwt({ email: 'wipe@example.com' }),
      access_token: makeJwt({ email: 'wipe@example.com' }),
      refresh_token: 'rt_wipe',
      account_id: 'acct-wipe'
    }
  });
  writeJson(path.join(profilesDir, '7', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '7days', remainingPct: 0, resetAtMs: Date.now() + (7 * 24 * 60 * 60 * 1000) }]
  });
  writeJson(path.join(clipAuthDir, 'wipe@example.com.json'), {
    type: 'codex',
    email: 'wipe@example.com',
    refresh_token: 'rt_wipe',
    account_id: 'acct-wipe'
  });

  const result = runScript(['--home', homeDir, '--cliproxyapi-auth-dir', clipAuthDir, '--apply', '--json']);
  assert.equal(result.status, 0, result.stderr);

  assert.equal(fs.existsSync(path.join(profilesDir, '7')), false);
  assert.equal(fs.existsSync(path.join(clipAuthDir, 'wipe@example.com.json')), false);
});
