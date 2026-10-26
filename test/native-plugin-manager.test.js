'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { createNativePluginManager } = require('../lib/native-resources/native-plugin-manager');
const fixtureSource = path.resolve(__dirname, '../examples/native-plugins/aih-demo');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-plugin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = {
    aiHomeDir: path.join(dir, 'aih'), hostHomeDir: path.join(dir, 'host'),
    nativeBinaries: {
      codex: '/Users/model/.codex/packages/standalone/current/bin/codex.aih-original',
      claude: '/Users/model/.local/bin/claude', opencode: '/Users/model/Library/pnpm/bin/opencode'
    }
  };
  return { dir, options, manager: createNativePluginManager(options) };
}
function envFor(provider, host) {
  return { ...process.env, HOME: host, USERPROFILE: host, CODEX_HOME: path.join(host, '.codex'), CLAUDE_CONFIG_DIR: path.join(host, '.claude'), XDG_CONFIG_HOME: path.join(host, '.config'), XDG_DATA_HOME: path.join(host, '.local/share'), XDG_CACHE_HOME: path.join(host, '.cache'), NO_PROXY: '127.0.0.1,localhost' };
}
for (const provider of ['claude', 'opencode']) {
  test(`${provider}: install enable disable remove preserves foreign config and is idempotent`, (t) => {
    const f = fixture(t);
    const targetBefore = provider === 'claude' ? path.join(f.options.hostHomeDir, '.claude', 'settings.json') : path.join(f.options.hostHomeDir, '.config/opencode/opencode.json');
    fs.mkdirSync(path.dirname(targetBefore), { recursive: true }); fs.writeFileSync(targetBefore, provider === 'claude' ? '{"permissions":{"allow":["Read"]}}' : '{"theme":"keep"}');
    const installed = f.manager.install(fixtureSource, { provider });
    assert.equal(installed.pluginId, 'aih-demo'); assert.equal(installed.enabled, true);
    const record = f.manager.list({ provider }).resources[0];
    assert.ok(fs.existsSync(record.target));
    assert.deepEqual(f.manager.install(fixtureSource, { provider }).digest, installed.digest);
    const revision = f.manager.list().revision;
    f.manager.enable('aih-demo', { provider }); assert.equal(f.manager.list().revision, revision);
    f.manager.disable('aih-demo', { provider }); assert.equal(fs.existsSync(record.target), false);
    assert.match(fs.readFileSync(targetBefore, 'utf8'), /keep|Read/);
    f.manager.enable('aih-demo', { provider });
    f.manager.remove('aih-demo', { provider });
    assert.equal(f.manager.list().resources.length, 0); assert.equal(fs.existsSync(record.target), false);
  });
}
test('Claude native CLI discovers the generated skills-dir plugin', (t) => {
  const f = fixture(t); const binary = f.options.nativeBinaries.claude;
  const record = f.manager.install(fixtureSource, { provider: 'claude' });
  const result = spawnSync(binary, ['plugin', 'list', '--json'], { cwd: f.dir, env: envFor('claude', f.options.hostHomeDir), encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  const listed = JSON.parse(result.stdout);
  assert.equal(listed.some(item => item.id === 'aih-demo@skills-dir' && item.enabled === true), true);
  f.manager.disable('aih-demo', { provider: 'claude' });
  const after = spawnSync(binary, ['plugin', 'list', '--json'], { cwd: f.dir, env: envFor('claude', f.options.hostHomeDir), encoding: 'utf8', timeout: 20000 });
  assert.equal(JSON.parse(after.stdout).some(item => item.id === 'aih-demo@skills-dir'), false);
  assert.equal(record.mode, 'native');
});
test('Codex native CLI installs a local marketplace plugin in isolated CODEX_HOME', (t) => {
  const f = fixture(t); const binary = f.options.nativeBinaries.codex;
  const record = f.manager.install(fixtureSource, { provider: 'codex' });
  assert.equal(record.nativeInstall.status, 'installed');
  const list = spawnSync(binary, ['plugin', 'list', '--json'], { cwd: f.dir, env: envFor('codex', f.options.hostHomeDir), encoding: 'utf8', timeout: 30000 });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).installed.some(item => item.pluginId === 'aih-demo@aih-local'), true);
  f.manager.disable('aih-demo', { provider: 'codex' });
  const after = spawnSync(binary, ['plugin', 'list', '--json'], { cwd: f.dir, env: envFor('codex', f.options.hostHomeDir), encoding: 'utf8', timeout: 30000 });
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).installed.some(item => item.pluginId === 'aih-demo@aih-local'), false);
});
test('Pi and DeepSeek fail closed with explicit runtime/projection gaps', (t) => {
  const f = fixture(t);
  for (const provider of ['pi', 'deepseek']) {
    assert.throws(() => f.manager.install(fixtureSource, { provider }), error => error.code === 'native_plugin_provider_unsupported');
    const row = f.manager.capability(provider);
    assert.equal(row.state, 'unsupported'); assert.ok(row.reason);
  }
});
test('modified owned plugin and foreign same-name paths are protected', (t) => {
  const f = fixture(t);
  const record = f.manager.install(fixtureSource, { provider: 'claude' });
  fs.appendFileSync(path.join(record.target, 'skills/aih-demo/SKILL.md'), '\nUSER_EDIT');
  assert.throws(() => f.manager.remove('aih-demo', { provider: 'claude' }), { code: 'native_plugin_target_modified' });
  const foreign = path.join(f.options.hostHomeDir, '.claude', 'skills', 'foreign');
  fs.mkdirSync(foreign, { recursive: true }); fs.writeFileSync(path.join(foreign, 'mine'), 'keep');
  assert.equal(fs.readFileSync(path.join(foreign, 'mine'), 'utf8'), 'keep');
});
