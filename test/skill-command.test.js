'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runSkillCommand } = require('../lib/cli/services/skill-command');
const { createSkillManager } = require('../lib/native-resources/skill-manager');
const { ensureProviderSkillInstalled, resolveSkillAssetDir } = require('../lib/cli/services/ai-cli/provider-skill-installer');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-skill-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = [];
  const context = { aiHomeDir: path.join(dir, 'aih'), hostHomeDir: path.join(dir, 'host'), consoleImpl: { log: (s) => output.push(s), error: (s) => output.push(s) } };
  return { dir, output, context, manager: createSkillManager(context) };
}
test('CLI reports actual install/list/disable/enable/remove state and subcommand help', async (t) => {
  const f = fixture(t);
  const source = resolveSkillAssetDir();
  for (const action of ['install', 'list', 'enable', 'disable', 'remove', 'doctor']) {
    assert.equal(await runSkillCommand(['skill', action, '--help'], f.context), 0);
    assert.match(f.output.at(-1), /Usage: aih skill/);
  }
  assert.equal(await runSkillCommand(['skill', 'install', source, '--provider', 'codex', '--json'], f.context), 0);
  const target = JSON.parse(f.output.at(-1)).results[0].target;
  assert.equal(fs.existsSync(path.join(target, 'SKILL.md')), true);
  for (const action of ['disable', 'enable', 'remove']) {
    assert.equal(await runSkillCommand(['skill', action, 'aih-collab', '--provider', 'codex', '--json'], f.context), 0);
    assert.equal(fs.existsSync(target), action === 'enable');
  }
  assert.equal(await runSkillCommand(['skill', 'list', '--json'], f.context), 0);
  assert.equal(JSON.parse(f.output.at(-1)).resources.length, 0);
});
test('CLI rejects unknown flags, missing provider, unsupported provider and conflicting selectors', async (t) => {
  const f = fixture(t);
  const source = resolveSkillAssetDir();
  for (const args of [
    ['install', source], ['install', source, '--provider', 'cline'],
    ['install', source, '--provider', 'codex', '--all-supported'],
    ['install', source, '--provider', 'codex', '--typo'], ['list', '--provider']
  ]) assert.equal(await runSkillCommand(['skill', ...args, '--json'], f.context), 1);
  assert.equal(f.manager.list().resources.length, 0);
});
for (const provider of ['codex', 'claude', 'opencode', 'agy']) {
  test(`${provider}: launch adopts legacy collab and respects CLI disable on following launches`, async (t) => {
    const f = fixture(t);
    const source = resolveSkillAssetDir();
    const projected = f.manager.target('aih-collab', { provider });
    fs.mkdirSync(path.dirname(projected.target), { recursive: true });
    if (projected.mode === 'native') fs.symlinkSync(source, projected.target, 'dir');
    else fs.writeFileSync(projected.target, 'USER TEXT\n<!-- aih-collab:v1:begin -->\n' + fs.readFileSync(path.join(source, 'instructions.md'), 'utf8').trim() + '\n<!-- aih-collab:end -->\n');
    const launch = { ...f.context, cliName: provider, sandboxDir: path.join(f.dir, 'account'), baseEnv: {} };
    assert.equal(ensureProviderSkillInstalled(launch).status, 'installed');
    assert.equal(f.manager.list().resources.length, 1);
    if (projected.mode !== 'native') assert.doesNotMatch(fs.readFileSync(projected.target, 'utf8'), /aih-collab:v1:begin/);
    f.manager.disable('aih-collab', { provider });
    ensureProviderSkillInstalled(launch);
    assert.equal(f.manager.list().resources[0].enabled, false);
    assert.equal(f.manager.doctor().healthy, true);
  });
}
test('skillInject=0 reconciles a disabled managed record and login performs no writes', (t) => {
  const f = fixture(t);
  const launch = { ...f.context, cliName: 'codex', sandboxDir: path.join(f.dir, 'account'), baseEnv: {} };
  assert.equal(ensureProviderSkillInstalled({ ...launch, isLogin: true }).reason, 'login_flow');
  assert.equal(f.manager.list().resources.length, 0);
  ensureProviderSkillInstalled(launch);
  ensureProviderSkillInstalled({ ...launch, baseEnv: { AIH_CLI_FEATURES: 'skillInject=0' } });
  assert.equal(f.manager.list().resources[0].enabled, false);
});
test('executable root CLI dispatches skill management in an isolated home', (t) => {
  const f = fixture(t);
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['bin/ai-home.js', 'skill', 'list', '--json'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, AIH_HOME_DIR: f.context.aiHomeDir, AIH_HOST_HOME: f.context.hostHomeDir }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).resources, []);
});
