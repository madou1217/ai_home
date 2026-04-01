const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fse = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { createHostConfigSyncer } = require('../lib/account/host-sync');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-host-sync-'));
}

test('syncGlobalConfigToHost syncs only codex auth and removes sandbox-owned shared entries when host source is absent', () => {
  const root = mkTmpDir();
  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const accountGlobalDir = path.join(profilesDir, 'codex', '1', '.codex');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  fs.mkdirSync(accountGlobalDir, { recursive: true });
  fs.mkdirSync(hostCodexDir, { recursive: true });
  fs.writeFileSync(path.join(accountGlobalDir, 'auth.json'), '{"token":"sandbox"}\n');
  fs.writeFileSync(path.join(accountGlobalDir, 'config.toml'), 'model = "gpt-5"\n');
  fs.writeFileSync(path.join(hostCodexDir, 'auth.json'), '{"token":"host"}\n');

  const syncGlobalConfigToHost = createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } }
  });

  const result = syncGlobalConfigToHost('codex', '1');
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(hostCodexDir, 'auth.json'), 'utf8'), '{"token":"sandbox"}\n');
  assert.equal(fs.existsSync(path.join(hostCodexDir, 'config.toml')), false);
  assert.equal(fs.existsSync(path.join(accountGlobalDir, 'config.toml')), false);
  assert.equal(fs.lstatSync(path.join(accountGlobalDir, 'auth.json')).isSymbolicLink(), false);

  fs.rmSync(root, { recursive: true, force: true });
});
