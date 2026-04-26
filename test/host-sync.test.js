const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fse = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { createHostConfigSyncer } = require('../lib/account/host-sync');
const { getAihProviderKey } = require('../lib/cli/services/pty/codex-config-sync');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-host-sync-'));
}

test('syncGlobalConfigToHost syncs only codex auth and keeps account-owned config isolated', () => {
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
  assert.equal(fs.lstatSync(path.join(hostCodexDir, 'auth.json')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(hostCodexDir, 'auth.json'), 'utf8'), '{"token":"sandbox"}\n');
  assert.equal(fs.existsSync(path.join(hostCodexDir, 'config.toml')), false);
  assert.equal(fs.existsSync(path.join(accountGlobalDir, 'config.toml')), true);
  assert.equal(fs.readFileSync(path.join(accountGlobalDir, 'config.toml'), 'utf8'), 'model = "gpt-5"\n');
  assert.equal(fs.lstatSync(path.join(accountGlobalDir, 'auth.json')).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(hostCodexDir, 'hooks.json')), true);
  assert.equal(fs.existsSync(path.join(hostCodexDir, 'hooks', 'aih-stop-notify.js')), true);
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(hostCodexDir, 'hooks.json'), 'utf8'));
  assert.equal(Array.isArray(hooksConfig.hooks.Stop), true);
  assert.equal(
    hooksConfig.hooks.Stop.some((group) =>
      Array.isArray(group && group.hooks)
      && group.hooks.some((hook) => String(hook.command || '').includes('aih-stop-notify.js'))
    ),
    true
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test('syncGlobalConfigToHost writes managed codex api-key provider config into host config.toml', () => {
  const root = mkTmpDir();
  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const accountGlobalDir = path.join(profilesDir, 'codex', '10', '.codex');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  fs.mkdirSync(accountGlobalDir, { recursive: true });
  fs.mkdirSync(hostCodexDir, { recursive: true });
  fs.writeFileSync(path.join(accountGlobalDir, 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: 'dummy'
  }, null, 2));

  const syncGlobalConfigToHost = createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } }
  });

  const result = syncGlobalConfigToHost('codex', '10');
  assert.equal(result.ok, true);

  const hostConfig = fs.readFileSync(path.join(hostCodexDir, 'config.toml'), 'utf8');
  const providerKey = getAihProviderKey('10');
  assert.match(hostConfig, /^preferred_auth_method = "apikey"/m);
  assert.match(hostConfig, new RegExp(`^model_provider = "${providerKey}"$`, 'm'));
  assert.match(hostConfig, new RegExp(`^\\[model_providers\\.${providerKey}\\]$`, 'm'));
  assert.match(hostConfig, /^base_url = "http:\/\/127\.0\.0\.1:8317\/v1"$/m);
  assert.match(hostConfig, /^bearer_token = "dummy"$/m);
  assert.match(hostConfig, /^\[features\]$/m);
  assert.match(hostConfig, /^codex_hooks = true$/m);

  fs.rmSync(root, { recursive: true, force: true });
});

test('syncGlobalConfigToHost keeps prior account provider blocks and switches model_provider to selected account block', () => {
  const root = mkTmpDir();
  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  const account10Dir = path.join(profilesDir, 'codex', '10', '.codex');
  const account11Dir = path.join(profilesDir, 'codex', '11', '.codex');
  fs.mkdirSync(account10Dir, { recursive: true });
  fs.mkdirSync(account11Dir, { recursive: true });
  fs.mkdirSync(hostCodexDir, { recursive: true });

  fs.writeFileSync(path.join(account10Dir, 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: 'dummy-10'
  }, null, 2));
  fs.writeFileSync(path.join(profilesDir, 'codex', '10', '.aih_env.json'), JSON.stringify({
    OPENAI_API_KEY: 'dummy-10'
  }, null, 2));

  fs.writeFileSync(path.join(account11Dir, 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: 'dummy-11'
  }, null, 2));
  fs.writeFileSync(path.join(profilesDir, 'codex', '11', '.aih_env.json'), JSON.stringify({
    OPENAI_API_KEY: 'dummy-11',
    OPENAI_BASE_URL: 'https://b.example.com/v1'
  }, null, 2));

  const syncGlobalConfigToHost = createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } }
  });

  const firstResult = syncGlobalConfigToHost('codex', '10');
  assert.equal(firstResult.ok, true);

  const secondResult = syncGlobalConfigToHost('codex', '11');
  assert.equal(secondResult.ok, true);
  assert.equal(fs.lstatSync(path.join(hostCodexDir, 'auth.json')).isSymbolicLink(), true);
  assert.equal(
    fs.readlinkSync(path.join(hostCodexDir, 'auth.json')),
    path.join(account11Dir, 'auth.json')
  );

  const hostConfig = fs.readFileSync(path.join(hostCodexDir, 'config.toml'), 'utf8');
  const provider10 = getAihProviderKey('10');
  const provider11 = getAihProviderKey('11');

  assert.match(hostConfig, new RegExp(`^model_provider = "${provider11}"$`, 'm'));
  assert.match(hostConfig, new RegExp(`\\[model_providers\\.${provider10}\\][\\s\\S]*?base_url = "http://127\\.0\\.0\\.1:8317/v1"[\\s\\S]*?bearer_token = "dummy"`));
  assert.match(hostConfig, new RegExp(`\\[model_providers\\.${provider11}\\][\\s\\S]*?base_url = "https://b\\.example\\.com/v1"[\\s\\S]*?bearer_token = "dummy-11"`));

  fs.rmSync(root, { recursive: true, force: true });
});

test('syncGlobalConfigToHost links all non-sensitive host codex entries back into account dir', () => {
  const root = mkTmpDir();
  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const accountGlobalDir = path.join(profilesDir, 'codex', '12', '.codex');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  fs.mkdirSync(path.join(accountGlobalDir, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(hostCodexDir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(accountGlobalDir, 'auth.json'), '{"token":"sandbox"}\n');
  fs.writeFileSync(path.join(accountGlobalDir, 'config.toml'), 'model = "account"\n');
  fs.writeFileSync(path.join(hostCodexDir, 'hooks', 'aih-stop-notify.js'), 'console.log("hook");\n');
  fs.writeFileSync(path.join(hostCodexDir, 'hooks.json'), '{"hooks":{}}\n');
  fs.writeFileSync(path.join(hostCodexDir, 'custom-state.json'), '{"shared":true}\n');

  const syncGlobalConfigToHost = createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } }
  });

  const result = syncGlobalConfigToHost('codex', '12');
  assert.equal(result.ok, true);
  assert.equal(fs.lstatSync(path.join(accountGlobalDir, 'hooks')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountGlobalDir, 'hooks.json')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountGlobalDir, 'custom-state.json')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountGlobalDir, 'config.toml')).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(accountGlobalDir, 'auth.json')).isSymbolicLink(), false);

  fs.rmSync(root, { recursive: true, force: true });
});
