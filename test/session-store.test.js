const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fse = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { createSessionStoreService } = require('../lib/cli/services/session-store');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-store-'));
}

test('ensureSessionStoreLinks drops sandbox-owned codex shared config entries and keeps auth isolated', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const accountConfigDir = path.join(profilesDir, 'codex', '1', '.codex');
  fs.mkdirSync(accountConfigDir, { recursive: true });
  fs.writeFileSync(path.join(accountConfigDir, 'auth.json'), '{"token":"secret"}\n');
  fs.writeFileSync(path.join(accountConfigDir, 'config.toml'), 'model = "gpt-5"\n');
  fs.mkdirSync(path.join(accountConfigDir, 'memories'), { recursive: true });
  fs.writeFileSync(path.join(accountConfigDir, 'memories', 'note.md'), 'remember me\n');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('codex', '1');
  assert.equal(result.migrated >= 2, true);
  assert.equal(fs.existsSync(path.join(hostHomeDir, '.codex', 'config.toml')), false);
  assert.equal(fs.existsSync(path.join(hostHomeDir, '.codex', 'memories')), false);
  assert.equal(fs.existsSync(path.join(accountConfigDir, 'config.toml')), false);
  assert.equal(fs.existsSync(path.join(accountConfigDir, 'memories')), false);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'auth.json')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(accountConfigDir, 'auth.json'), 'utf8'), '{"token":"secret"}\n');
});

test('ensureSessionStoreLinks links additional codex host state directories when present', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const accountConfigDir = path.join(profilesDir, 'codex', '2', '.codex');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  fs.mkdirSync(accountConfigDir, { recursive: true });
  fs.mkdirSync(path.join(hostCodexDir, 'sqlite'), { recursive: true });
  fs.mkdirSync(path.join(hostCodexDir, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(hostCodexDir, 'worktrees'), { recursive: true });
  fs.writeFileSync(path.join(hostCodexDir, 'sqlite', 'state.db'), 'sqlite\n');
  fs.writeFileSync(path.join(hostCodexDir, 'prompts', 'saved.md'), 'prompt\n');
  fs.writeFileSync(path.join(hostCodexDir, 'worktrees', 'meta.json'), '{}\n');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('codex', '2');
  assert.equal(result.linked >= 3, true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'sqlite')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'prompts')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'worktrees')).isSymbolicLink(), true);
});
