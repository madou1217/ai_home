'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSkillManager } = require('../lib/native-resources/skill-manager');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-skills-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { aiHomeDir: path.join(dir, 'aih'), hostHomeDir: path.join(dir, 'host') };
  const source = path.join(dir, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: aih-demo\ndescription: A deterministic demo\n---\nReply AIH_SKILL_DEMO_OK when requested.\n');
  fs.writeFileSync(path.join(source, 'instructions.md'), 'Reply AIH_SKILL_DEMO_OK when requested.\n');
  return { ...options, options, source, manager: createSkillManager(options) };
}

for (const provider of ['codex', 'claude']) {
  test(`${provider}: install/use/disable/re-enable/remove survives manager recreation`, (t) => {
    const f = fixture(t);
    const installed = f.manager.install(f.source, { provider });
    assert.equal(installed.enabled, true);
    assert.match(fs.readFileSync(path.join(installed.target, 'SKILL.md'), 'utf8'), /AIH_SKILL_DEMO_OK/);
    const revision = f.manager.list().revision;
    assert.equal(f.manager.install(f.source, { provider }).digest, installed.digest);
    assert.equal(f.manager.list().revision, revision, 'idempotent install');
    fs.rmSync(f.source, { recursive: true });
    const manager = createSkillManager(f.options);
    manager.disable('aih-demo', { provider });
    assert.equal(fs.existsSync(installed.target), false);
    assert.equal(manager.list({ provider }).resources[0].enabled, false);
    manager.enable('aih-demo', { provider });
    assert.match(fs.readFileSync(path.join(installed.target, 'SKILL.md'), 'utf8'), /AIH_SKILL_DEMO_OK/);
    manager.remove('aih-demo', { provider });
    assert.equal(fs.existsSync(installed.target), false);
    assert.equal(manager.list({ provider }).resources.length, 0);
  });
}
for (const provider of ['opencode', 'agy']) {
  test(`${provider}: managed instructions preserve foreign text and other skills`, (t) => {
    const f = fixture(t);
    const target = f.manager.target('aih-demo', { provider }).target;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'User instructions.\n');
    f.manager.install(f.source, { provider });
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8') + '\nUser appended text.\n');
    f.manager.disable('aih-demo', { provider });
    assert.equal(fs.readFileSync(target, 'utf8'), 'User instructions.\n\nUser appended text.\n');
    f.manager.enable('aih-demo', { provider });
    assert.match(fs.readFileSync(target, 'utf8'), /AIH_SKILL_DEMO_OK/);
    f.manager.remove('aih-demo', { provider });
    assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /AIH_SKILL_DEMO_OK/);
  });
}
test('foreign directories and symlinks are never overwritten or removed', (t) => {
  const f = fixture(t);
  const target = f.manager.target('aih-demo', { provider: 'codex' }).target;
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'mine'), 'keep');
  assert.throws(() => f.manager.install(f.source, { provider: 'codex' }), { code: 'skill_target_conflict' });
  assert.equal(fs.readFileSync(path.join(target, 'mine'), 'utf8'), 'keep');
  fs.rmSync(target, { recursive: true });
  fs.symlinkSync(f.source, target, 'dir');
  assert.throws(() => f.manager.install(f.source, { provider: 'codex' }), { code: 'skill_target_conflict' });
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
});
test('user edits to a managed skill block cleanup and are visible in doctor', (t) => {
  const f = fixture(t);
  const record = f.manager.install(f.source, { provider: 'claude' });
  fs.appendFileSync(path.join(record.target, 'SKILL.md'), 'USER EDIT');
  assert.throws(() => f.manager.remove('aih-demo', { provider: 'claude' }), { code: 'skill_target_modified' });
  assert.equal(f.manager.doctor().healthy, false);
  assert.match(fs.readFileSync(path.join(record.target, 'SKILL.md'), 'utf8'), /USER EDIT/);
});
test('builtin reconciliation respects durable disable and removal', (t) => {
  const f = fixture(t);
  f.manager.reconcileBuiltin(f.source, { provider: 'codex' });
  f.manager.disable('aih-demo', { provider: 'codex' });
  createSkillManager(f.options).reconcileBuiltin(f.source, { provider: 'codex' });
  assert.equal(f.manager.list().resources[0].enabled, false);
  f.manager.remove('aih-demo', { provider: 'codex' });
  createSkillManager(f.options).reconcileBuiltin(f.source, { provider: 'codex' });
  assert.equal(f.manager.list().resources.length, 0);
  assert.equal(fs.existsSync(f.manager.target('aih-demo', { provider: 'codex' }).target), false);
});
test('unsupported providers and unsafe skill sources fail before projection', (t) => {
  const f = fixture(t);
  assert.throws(() => f.manager.install(f.source, { provider: 'cline' }), { code: 'skill_provider_unsupported' });
  fs.symlinkSync('/etc/hosts', path.join(f.source, 'outside'));
  assert.throws(() => f.manager.install(f.source, { provider: 'codex' }), { code: 'skill_source_symlink' });
  fs.unlinkSync(path.join(f.source, 'outside'));
  fs.writeFileSync(path.join(f.source, 'SKILL.md'), '---\nname: ../escape\ndescription: bad\n---\nBad');
  assert.throws(() => f.manager.install(f.source, { provider: 'codex' }), { code: 'skill_id_invalid' });
});
test('AGY uses the host GEMINI instruction file shared with account projections', (t) => {
  const f = fixture(t);
  const record = f.manager.install(f.source, { provider: 'agy' });
  assert.equal(record.target, path.join(f.hostHomeDir, '.gemini', 'GEMINI.md'));
});
test('two skills in one instruction file can be independently removed', (t) => {
  const f = fixture(t);
  const first = f.manager.install(f.source, { provider: 'opencode' });
  fs.writeFileSync(path.join(f.source, 'SKILL.md'), '---\nname: second-demo\ndescription: Second\n---\nSecond marker');
  fs.writeFileSync(path.join(f.source, 'instructions.md'), 'SECOND_MARKER');
  f.manager.install(f.source, { provider: 'opencode' });
  f.manager.remove('aih-demo', { provider: 'opencode' });
  const text = fs.readFileSync(first.target, 'utf8');
  assert.match(text, /SECOND_MARKER/);
  assert.doesNotMatch(text, /AIH_SKILL_DEMO_OK/);
});
