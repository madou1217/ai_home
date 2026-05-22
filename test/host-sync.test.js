const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fse = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { createHostConfigSyncer } = require('../lib/account/host-sync');
const {
  AIH_CODEX_PROVIDER_BASE_URL,
  getAihProviderKey
} = require('../lib/cli/services/pty/codex-config-sync');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-host-sync-'));
}

test('syncGlobalConfigToHost writes codex auth as an independent global snapshot', () => {
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
    cliConfigs: { codex: { globalDir: '.codex' } },
    codexVersion: '0.114.0'
  });

  const result = syncGlobalConfigToHost('codex', '1');
  assert.equal(result.ok, true);
  assert.equal(fs.lstatSync(path.join(hostCodexDir, 'auth.json')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(hostCodexDir, 'auth.json'), 'utf8'), '{"token":"sandbox"}\n');
  fs.writeFileSync(path.join(accountGlobalDir, 'auth.json'), '{"token":"changed"}\n');
  assert.equal(
    fs.readFileSync(path.join(hostCodexDir, 'auth.json'), 'utf8'),
    '{"token":"sandbox"}\n'
  );
  assert.equal(fs.existsSync(path.join(hostCodexDir, 'config.toml')), true);
  assert.match(fs.readFileSync(path.join(hostCodexDir, 'config.toml'), 'utf8'), /^preferred_auth_method = "oauth"$/m);
  assert.match(fs.readFileSync(path.join(hostCodexDir, 'config.toml'), 'utf8'), /^model_provider = "openai"$/m);
  assert.equal(fs.existsSync(path.join(accountGlobalDir, 'config.toml')), true);
  assert.equal(fs.readFileSync(path.join(accountGlobalDir, 'config.toml'), 'utf8'), 'model = "gpt-5"\n');
  assert.equal(fs.lstatSync(path.join(accountGlobalDir, 'auth.json')).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(hostCodexDir, 'hooks.json')), false);
  assert.equal(fs.existsSync(path.join(hostCodexDir, 'hooks', 'aih-stop-notify.js')), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('syncGlobalConfigToHost replaces legacy host auth symlink with independent codex auth snapshot', () => {
  const root = mkTmpDir();
  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const accountGlobalDir = path.join(profilesDir, 'codex', '1', '.codex');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  fs.mkdirSync(accountGlobalDir, { recursive: true });
  fs.mkdirSync(hostCodexDir, { recursive: true });
  fs.writeFileSync(path.join(accountGlobalDir, 'auth.json'), '{"token":"sandbox"}\n');
  fs.symlinkSync(path.join(accountGlobalDir, 'auth.json'), path.join(hostCodexDir, 'auth.json'));

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
  assert.equal(fs.existsSync(path.join(hostCodexDir, 'auth.json')), true);
  assert.equal(fs.lstatSync(path.join(hostCodexDir, 'auth.json')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(hostCodexDir, 'auth.json'), 'utf8'), '{"token":"sandbox"}\n');
  assert.equal(fs.existsSync(path.join(accountGlobalDir, 'auth.json')), true);

  fs.rmSync(root, { recursive: true, force: true });
});

test('syncGlobalConfigToHost installs codex stop hook only when explicitly enabled', () => {
  const root = mkTmpDir();
  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const accountGlobalDir = path.join(profilesDir, 'codex', '1', '.codex');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  fs.mkdirSync(accountGlobalDir, { recursive: true });
  fs.mkdirSync(hostCodexDir, { recursive: true });
  fs.writeFileSync(path.join(accountGlobalDir, 'auth.json'), '{"token":"sandbox"}\n');

  const syncGlobalConfigToHost = createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    codexVersion: '0.114.0',
    enableCodexStopHook: true
  });

  const result = syncGlobalConfigToHost('codex', '1');
  assert.equal(result.ok, true);
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

test('syncGlobalConfigToHost removes managed codex stop hook by default', () => {
  const root = mkTmpDir();
  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const accountGlobalDir = path.join(profilesDir, 'codex', '1', '.codex');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  fs.mkdirSync(accountGlobalDir, { recursive: true });
  fs.mkdirSync(path.join(hostCodexDir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(accountGlobalDir, 'auth.json'), '{"token":"sandbox"}\n');
  fs.writeFileSync(path.join(hostCodexDir, 'hooks.json'), JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `/usr/bin/env node "${path.join(hostCodexDir, 'hooks', 'aih-stop-notify.js')}"`,
              timeout: 10
            },
            {
              type: 'command',
              command: '/usr/bin/env node "/tmp/keep.js"',
              timeout: 10
            }
          ]
        }
      ]
    }
  }, null, 2) + '\n', 'utf8');

  const syncGlobalConfigToHost = createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    codexVersion: '0.130.0'
  });

  const result = syncGlobalConfigToHost('codex', '1');
  assert.equal(result.ok, true);
  assert.equal(result.codexHook.reason, 'stop_hook_disabled');
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(hostCodexDir, 'hooks.json'), 'utf8'));
  assert.equal(hooksConfig.hooks.Stop[0].hooks.length, 1);
  assert.equal(hooksConfig.hooks.Stop[0].hooks[0].command, '/usr/bin/env node "/tmp/keep.js"');

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
  assert.match(hostConfig, new RegExp(`^base_url = "${AIH_CODEX_PROVIDER_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'));
  assert.match(hostConfig, /^bearer_token = "dummy"$/m);
  assert.match(hostConfig, /^\[features\]$/m);
  assert.match(hostConfig, /^hooks = true$/m);
  assert.doesNotMatch(hostConfig, /^codex_hooks\s*=/m);

  fs.rmSync(root, { recursive: true, force: true });
});

test('syncGlobalConfigToHost switches host config to oauth mode when account has no api key', () => {
  const root = mkTmpDir();
  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const accountGlobalDir = path.join(profilesDir, 'codex', '20', '.codex');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  fs.mkdirSync(accountGlobalDir, { recursive: true });
  fs.mkdirSync(hostCodexDir, { recursive: true });
  fs.writeFileSync(path.join(accountGlobalDir, 'auth.json'), JSON.stringify({
    tokens: {
      access_token: 'oauth-access-token'
    }
  }, null, 2));

  const syncGlobalConfigToHost = createHostConfigSyncer({
    fs,
    fse,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } }
  });

  const result = syncGlobalConfigToHost('codex', '20');
  assert.equal(result.ok, true);

  const hostConfig = fs.readFileSync(path.join(hostCodexDir, 'config.toml'), 'utf8');
  assert.match(hostConfig, /^preferred_auth_method = "oauth"/m);
  assert.match(hostConfig, /^model_provider = "openai"/m);
  assert.doesNotMatch(hostConfig, /^\[model_providers\.aih_20\]$/m);

  fs.rmSync(root, { recursive: true, force: true });
});

test('syncGlobalConfigToHost keeps legacy codex hook flag for older codex versions', () => {
  const root = mkTmpDir();
  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const accountGlobalDir = path.join(profilesDir, 'codex', '9', '.codex');
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
    cliConfigs: { codex: { globalDir: '.codex' } },
    codexVersion: '0.113.0'
  });

  const result = syncGlobalConfigToHost('codex', '9');
  assert.equal(result.ok, true);

  const hostConfig = fs.readFileSync(path.join(hostCodexDir, 'config.toml'), 'utf8');
  assert.match(hostConfig, /^codex_hooks = true$/m);
  assert.doesNotMatch(hostConfig, /^hooks\s*=/m);

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
  assert.equal(fs.lstatSync(path.join(hostCodexDir, 'auth.json')).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hostCodexDir, 'auth.json'), 'utf8')), {
    OPENAI_API_KEY: 'dummy-11'
  });

  const hostConfig = fs.readFileSync(path.join(hostCodexDir, 'config.toml'), 'utf8');
  const provider10 = getAihProviderKey('10');
  const provider11 = getAihProviderKey('11');

  assert.match(hostConfig, new RegExp(`^model_provider = "${provider11}"$`, 'm'));
  assert.match(hostConfig, new RegExp(`\\[model_providers\\.${provider10}\\][\\s\\S]*?base_url = "${AIH_CODEX_PROVIDER_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?bearer_token = "dummy"`));
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
