const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDoctorChecks } = require('../lib/doctor/checks');
const { createAuditLogger } = require('../lib/audit/logger');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-doctor-test-'));
}

test('doctor detects required-config, broken-link, and shared-topology anomalies', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const hostCodexDir = path.join(homeDir, '.codex');
  fs.mkdirSync(hostCodexDir, { recursive: true });
  fs.writeFileSync(path.join(hostCodexDir, 'config.toml'), 'model = "gpt-5"\n');

  const profilesDir = path.join(homeDir, '.ai_home', 'profiles', 'codex');
  fs.mkdirSync(path.join(profilesDir, '1'), { recursive: true });

  const configDir2 = path.join(profilesDir, '2', '.codex');
  fs.mkdirSync(configDir2, { recursive: true });
  fs.symlinkSync('missing-target', path.join(configDir2, 'sessions'));
  fs.writeFileSync(path.join(configDir2, 'config.toml'), 'model = "local"\n');

  const report = runDoctorChecks({
    hostHomeDir: homeDir,
    profilesDir: path.join(homeDir, '.ai_home', 'profiles'),
    cliConfigs: {
      codex: { globalDir: '.codex' }
    }
  });

  assert.equal(report.ok, false);
  assert.ok(report.summary.byType['required-config'] >= 1);
  assert.ok(report.summary.byType.link >= 1);
  assert.ok(
    report.issues.some((issue) => issue.message.includes('shared tool config entry should symlink')),
    'doctor should report shared codex entries that are still regular files'
  );
});

test('doctor detects permission anomaly when profiles directory is not writable', (t) => {
  const homeDir = mkTmpDir();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const profilesDir = path.join(homeDir, '.ai_home', 'profiles');
  fs.mkdirSync(profilesDir, { recursive: true });

  const mockFs = Object.create(fs);
  mockFs.accessSync = () => {
    const err = new Error('EACCES');
    err.code = 'EACCES';
    throw err;
  };

  const report = runDoctorChecks({
    fsImpl: mockFs,
    hostHomeDir: homeDir,
    profilesDir,
    cliConfigs: {}
  });

  assert.equal(report.ok, false);
  assert.ok(report.summary.byType.permission >= 1);
});

test('audit logger appends JSONL entries with action context', (t) => {
  const tmpDir = mkTmpDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const logPath = path.join(tmpDir, 'audit', 'cli-actions.jsonl');
  const logger = createAuditLogger({
    logPath,
    now: () => '2026-03-01T18:20:00+08:00'
  });

  const ok = logger.log('account.set-default', { cli: 'codex', accountId: '1' });
  assert.equal(ok, true);

  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.ts, '2026-03-01T18:20:00+08:00');
  assert.equal(event.action, 'account.set-default');
  assert.equal(event.context.cli, 'codex');
  assert.equal(event.context.accountId, '1');
});
