'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { healCodexConfigFile } = require('../lib/cli/services/pty/codex-config-heal');
const { runCodexDefaultCli } = require('../lib/server/codex-default-cli-launcher');
const { CODEX_MANAGED_LAUNCH_ENV } = require('../lib/runtime/codex-launch-context');

function fixture(t, content) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-config-heal-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, 'custom-codex');
  fs.mkdirSync(codexHome);
  const configPath = path.join(codexHome, 'config.toml');
  if (content !== undefined) fs.writeFileSync(configPath, content);
  return { home, codexHome, configPath };
}

for (const nameLine of ['', 'name = ""\n', "name = '  '\n", 'name = "\\t" # broken name\n']) {
  test(`managed provider name is repaired with backup: ${JSON.stringify(nameLine)}`, (t) => {
    const original = 'model_provider = "aih_server"\n[model_providers.aih_server]\n'
      + nameLine + 'base_url = "http://127.0.0.1:9999/v1"\nwire_api = "responses"\n'
      + '[model_providers.aih_server.auth]\ncommand = "existing-helper"\nargs = ["unchanged"]\n';
    const f = fixture(t, original);
    const result = healCodexConfigFile(f.configPath);
    const healed = fs.readFileSync(f.configPath, 'utf8');
    assert.equal(result.changed, true);
    assert.match(healed, /name = "AIH Server"/);
    assert.match(healed, /base_url = "http:\/\/127.0.0.1:9999\/v1"/);
    assert.match(healed, /command = "existing-helper"\nargs = \["unchanged"\]/);
    assert.equal(healed.includes('env_key'), false, 'auth command must never be mixed with env_key');
    assert.equal(fs.readFileSync(result.backupPath, 'utf8'), original);
    assert.equal(healCodexConfigFile(f.configPath).changed, false);
  });
}

test('an implicit managed provider created by its auth subtable receives a parent name', (t) => {
  const original = 'model_provider = "aih_server"\n[model_providers.aih_server.auth]\n'
    + 'command = "existing-helper"\n[model_providers.custom]\nname = "Custom"\n';
  const f = fixture(t, original);
  healCodexConfigFile(f.configPath);
  const healed = fs.readFileSync(f.configPath, 'utf8');
  assert.match(healed, /\[model_providers.aih_server\]\nname = "AIH Server"/);
  assert.match(healed, /\[model_providers.aih_server.auth\]\ncommand = "existing-helper"/);
  assert.match(healed, /\[model_providers.custom\]\nname = "Custom"/);
});

test('healthy managed config and unrelated providers remain byte-for-byte unchanged', (t) => {
  const original = '[model_providers.aih_server]\nname = "My Gateway"\n'
    + '[model_providers.custom]\nname = ""\n';
  const f = fixture(t, original);
  assert.equal(healCodexConfigFile(f.configPath).changed, false);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(f.codexHome), ['config.toml']);
});

test('quoted provider keys are repaired while multiline instruction examples are preserved', (t) => {
  const instructions = 'developer_instructions = """\n[model_providers.aih_server]\nname = ""\n"""\n';
  const original = instructions + '[model_providers."aih_server"] # managed\n'
    + '"name" = "" # restore this value\n[model_providers."aih_server".auth]\ncommand = "helper"\n';
  const f = fixture(t, original);
  healCodexConfigFile(f.configPath);
  const healed = fs.readFileSync(f.configPath, 'utf8');
  assert.ok(healed.startsWith(instructions));
  assert.match(healed, /"name" = "AIH Server" # restore this value/);
  assert.equal(healCodexConfigFile(f.configPath).changed, false);
});

test('provider restoration preserves existing inline and dotted TOML definitions', (t) => {
  for (const original of [
    'model_providers = { aih_server = { name = "Custom Gateway" } }\n',
    'model_providers.aih_server.name = "Custom Gateway"\n',
    '[model_providers]\naih_server = { name = "Custom Gateway" }\n'
  ]) {
    const f = fixture(t, original);
    const result = healCodexConfigFile(f.configPath, {
      missingProviderBlock: '[model_providers.aih_server]\nname = "AIH Server"'
    });
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
  }
});

function launch(f, spawn, env = {}, args = ['features', 'list']) {
  return runCodexDefaultCli('/test-owned/codex', args, {
    fs, aiHomeDir: path.join(f.home, '.ai_home'), spawn,
    processObj: { platform: 'darwin', env: { HOME: f.home, CODEX_HOME: f.codexHome, ...env },
      stderr: { write() {} }, exit() {}, kill() {}, pid: 123 }
  });
}

test('bare codex heals the effective CODEX_HOME before starting upstream', (t) => {
  const f = fixture(t, '[model_providers.aih_server]\nname = ""\n');
  const hostConfig = path.join(f.home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(hostConfig));
  fs.writeFileSync(hostConfig, '# untouched host config\n');
  launch(f, () => {
    assert.match(fs.readFileSync(f.configPath, 'utf8'), /name = "AIH Server"/);
    return new EventEmitter();
  });
  assert.equal(fs.readFileSync(hostConfig, 'utf8'), '# untouched host config\n');
});

test('gateway launch restores a missing provider from its scoped connection without persisting the key', (t) => {
  const f = fixture(t);
  const env = { [CODEX_MANAGED_LAUNCH_ENV]: '1', OPENAI_API_KEY: 'test-private-key',
    OPENAI_BASE_URL: 'http://127.0.0.1:9999/v1', AIH_CODEX_GATEWAY_ACCOUNT_REF: 'acct_test' };
  launch(f, (_file, args, options) => {
    const config = fs.readFileSync(f.configPath, 'utf8');
    assert.match(config, /name = "AIH Server"/);
    assert.match(config, /base_url = "http:\/\/127.0.0.1:9999\/v1"/);
    assert.match(config, /env_key = "OPENAI_API_KEY"/);
    assert.equal(config.includes('test-private-key'), false);
    assert.equal(JSON.stringify(args).includes('test-private-key'), false);
    assert.equal(args.some((arg) => /model_providers\..*\.name=/.test(arg)), false);
    assert.equal(options.env.OPENAI_API_KEY, 'test-private-key');
    return new EventEmitter();
  }, env, null);
});

test('installed Codex rejects the broken config and the real CLI helper repairs it before bootstrap', {
  skip: !process.env.AIH_TEST_CODEX_EXECUTABLE
}, (t) => {
  const f = fixture(t, 'model_provider = "aih_server"\n[model_providers.aih_server]\n'
    + 'name = ""\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\n');
  const binary = process.env.AIH_TEST_CODEX_EXECUTABLE;
  const options = { cwd: f.home, encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, HOME: f.home, USERPROFILE: f.home,
      AIH_HOST_HOME: f.home, CODEX_HOME: f.codexHome } };
  const before = spawnSync(binary, ['features', 'list'], options);
  assert.equal(before.status, 1, before.stderr);
  assert.match(before.stderr, /provider name must not be empty/);

  const args = [require.resolve('../lib/server/codex-app-server-stdio-proxy'),
    '--run-cli-default', '--upstream', binary, '--', 'features', 'list'];
  const healed = spawnSync(process.execPath, args, options);
  assert.equal(healed.status, 0, healed.stderr);
  assert.ok(healed.stdout.trim());
  assert.match(healed.stderr, /repaired managed provider aih_server/);
  const config = fs.readFileSync(f.configPath, 'utf8');
  const again = spawnSync(process.execPath, args, options);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stderr, /repaired managed provider/);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), config);
  assert.equal(fs.readdirSync(f.codexHome).filter((name) => name.includes('.aih-bak-')).length, 1);
});
