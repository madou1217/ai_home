'use strict';

// skills：公用实体 + 账号级启用（默认全开），只用软链接。
//
// 守四件事：
//   1) 共享库里的技能，默认全部在账号视图里出现（一人一份实体，链接各指一份）；
//   2) 禁用 = 删一条链接，不是删实体，也不影响别的账号；
//   3) 来源失效（实体被删）静默丢弃，不报错；
//   4) 账号自己放的真实目录不动（不接管、不删除）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listStoreSkills, reconcileAccountSkillLinks } = require('../lib/runtime/codebuddy-skills-links');

function withRoot(t, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fn({ root, store: path.join(root, 'store', 'skills'), account: path.join(root, 'account', 'skills') });
}

function addSkill(store, name) {
  const dir = path.join(store, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# ' + name + '\n');
  return dir;
}

test('默认全开：共享库的技能都链接进账号视图', (t) => withRoot(t, ({ store, account }) => {
  addSkill(store, 'aih-collab');
  addSkill(store, 'pdf');
  const result = reconcileAccountSkillLinks({ fs, path, storeSkillsDir: store, accountSkillsDir: account });

  assert.equal(result.linked, 2);
  assert.deepEqual(result.skipped, []);
  for (const name of ['aih-collab', 'pdf']) {
    const linkPath = path.join(account, name);
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, name);
    assert.equal(fs.readFileSync(path.join(linkPath, 'SKILL.md'), 'utf8'), '# ' + name + '\n');
  }
  assert.deepEqual(listStoreSkills({ fs, path, storeSkillsDir: store }).map((skill) => skill.name).sort(), ['aih-collab', 'pdf']);
}));

test('禁用 = 删链接，实体和其它账号不受影响', (t) => withRoot(t, ({ root, store, account }) => {
  addSkill(store, 'pdf');
  addSkill(store, 'docx');
  const other = path.join(root, 'other-account', 'skills');
  reconcileAccountSkillLinks({ fs, path, storeSkillsDir: store, accountSkillsDir: other });

  const result = reconcileAccountSkillLinks({
    fs, path, storeSkillsDir: store, accountSkillsDir: account, disabledSkills: ['pdf']
  });

  assert.equal(fs.existsSync(path.join(account, 'pdf')), false);
  assert.equal(fs.existsSync(path.join(account, 'docx')), true);
  assert.equal(fs.existsSync(path.join(store, 'pdf', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(other, 'pdf')), true);
  assert.ok(result.removed >= 0);
}));

test('来源失效：静默丢弃（不建链、不报错）', (t) => withRoot(t, ({ store, account }) => {
  addSkill(store, 'gone');
  fs.rmSync(path.join(store, 'gone'), { recursive: true, force: true });

  const result = reconcileAccountSkillLinks({ fs, path, storeSkillsDir: store, accountSkillsDir: account });
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(fs.readdirSync(account), []);

  // 先建好链接，再把实体删掉：下一次 reconcile 静默清掉悬空链接
  addSkill(store, 'temp');
  reconcileAccountSkillLinks({ fs, path, storeSkillsDir: store, accountSkillsDir: account });
  assert.equal(fs.lstatSync(path.join(account, 'temp')).isSymbolicLink(), true);
  fs.rmSync(path.join(store, 'temp'), { recursive: true, force: true });
  reconcileAccountSkillLinks({ fs, path, storeSkillsDir: store, accountSkillsDir: account });
  assert.equal(fs.existsSync(path.join(account, 'temp')), false);
}));

test('账号自己放的真实技能目录不动；旧的整体链接被换成逐技能链接', (t) => withRoot(t, ({ store, account }) => {
  addSkill(store, 'pdf');
  fs.mkdirSync(path.join(account, 'my-own'), { recursive: true });
  fs.writeFileSync(path.join(account, 'my-own', 'SKILL.md'), '# mine\n');

  const result = reconcileAccountSkillLinks({ fs, path, storeSkillsDir: store, accountSkillsDir: account });
  assert.deepEqual(result.unresolved, ['my-own']);
  assert.equal(fs.readFileSync(path.join(account, 'my-own', 'SKILL.md'), 'utf8'), '# mine\n');
  assert.equal(fs.lstatSync(path.join(account, 'pdf')).isSymbolicLink(), true);

  // 旧布局：账号 skills 整目录是指向共享库的链接 → 摘链接、建真目录、再逐技能链接
  const legacyAccount = path.join(store, '..', 'legacy-account', 'skills');
  fs.mkdirSync(path.dirname(legacyAccount), { recursive: true });
  fs.symlinkSync(store, legacyAccount);
  const legacyResult = reconcileAccountSkillLinks({ fs, path, storeSkillsDir: store, accountSkillsDir: legacyAccount });
  assert.equal(fs.lstatSync(legacyAccount).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(legacyAccount, 'pdf')).isSymbolicLink(), true);
  assert.ok(legacyResult.removed >= 1);
}));
