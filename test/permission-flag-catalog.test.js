'use strict';

// 权限参数目录（lib/providers/permission-flag-catalog.js）是「哪些旗标互斥、哪些
// 只是互相覆盖」的唯一事实源；测例逐条对应 docs/providers/cli-version-restrictions.md
// 里记录的真机实测结论，不新增未实测的组合。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describePermissionCatalog,
  findPermissionConflicts,
  findPermissionOverrides,
  getPermissionFlagCatalog,
  listPermissionIntentFlagForms,
  stripPermissionIntentFlags,
  validatePermissionArgs
} = require('../lib/providers/permission-flag-catalog');

test('permission catalog declares every shipped provider with bilingual copy', () => {
  const providers = [
    'codex', 'claude', 'gemini', 'agy', 'opencode', 'grok', 'kimi', 'qoder', 'codebuddy'
  ];
  for (const provider of providers) {
    const catalog = getPermissionFlagCatalog(provider);
    assert.ok(catalog.flags.length > 0, `${provider} 必须有权限旗标`);
    assert.notEqual(catalog.verifiedCliVersion, 'none', `${provider} 必须记录核实版本`);
    for (const entry of catalog.flags) {
      assert.ok(entry.flag.startsWith('--'), `${provider} ${entry.flag} 必须是长旗标`);
      assert.ok(entry.zh && entry.zh.length > 0, `${provider} ${entry.flag} 缺少中文说明`);
      assert.ok(entry.en && entry.en.length > 0, `${provider} ${entry.flag} 缺少英文原文`);
      assert.ok(entry.example.includes(entry.flag) || (entry.aliases || []).some((alias) => entry.example.includes(alias)),
        `${provider} ${entry.flag} 的用法示例必须用到这个旗标（或它的别名）`);
      assert.ok(entry.group, `${provider} ${entry.flag} 缺少分组`);
    }
  }
});

test('permission catalog resolves family aliases to one shared catalog', () => {
  assert.equal(getPermissionFlagCatalog('qodercn'), getPermissionFlagCatalog('qoder'));
  assert.equal(getPermissionFlagCatalog('workbuddy'), getPermissionFlagCatalog('codebuddy'));
  assert.equal(getPermissionFlagCatalog('codebuddycn'), getPermissionFlagCatalog('codebuddy'));
  assert.equal(getPermissionFlagCatalog('not-a-provider').flags.length, 0);
});

test('permission conflicts match the measured upstream rejections', () => {
  // codex 0.163.0：--approve-for-me × -a / -s；--dangerously-bypass-approvals-and-sandbox × -a
  assert.equal(
    findPermissionConflicts('codex', ['--approve-for-me', '-a', 'never']).length,
    1
  );
  assert.equal(
    findPermissionConflicts('codex', ['--approve-for-me', '--sandbox', 'read-only']).length,
    1
  );
  assert.equal(
    findPermissionConflicts('codex', ['--dangerously-bypass-approvals-and-sandbox', '-a', 'never']).length,
    1
  );
  // 后者覆盖 --sandbox 但不报错 → 只提示，不拦截
  assert.equal(
    findPermissionConflicts('codex', ['--dangerously-bypass-approvals-and-sandbox', '-s', 'read-only']).length,
    0
  );
  assert.equal(
    findPermissionOverrides('codex', ['--dangerously-bypass-approvals-and-sandbox', '-s', 'read-only']).length,
    1
  );
  // 无关参数不算冲突
  assert.equal(findPermissionConflicts('codex', ['--sandbox', '-a', 'never']).length, 0);
});

test('permission conflicts catch gemini yolo and kimi auto entries', () => {
  assert.equal(findPermissionConflicts('gemini', ['-y', '--approval-mode', 'default']).length, 1);
  assert.equal(findPermissionConflicts('gemini', ['--approval-mode', 'yolo']).length, 0);
  assert.equal(findPermissionConflicts('kimi', ['-y', '--auto']).length, 1);
});

test('permission conflicts are only declared for measured combinations', () => {
  // claude / agy / opencode / grok / qoder / codebuddy 目前没有实测到的互斥组合：
  // 宁可漏拦（上游自己报错）也不能误拦（把合法组合拒掉）。
  for (const provider of ['claude', 'agy', 'opencode', 'grok', 'qoder', 'codebuddy']) {
    const catalog = getPermissionFlagCatalog(provider);
    assert.equal(catalog.conflicts.length, 0, `${provider} 不应声明未实测的互斥`);
  }
});

test('permission catalog excludes hook-trust from permission intent forms', () => {
  const forms = listPermissionIntentFlagForms('codex');
  assert.ok(forms.includes('--sandbox'));
  assert.ok(forms.includes('-a'));
  assert.ok(forms.includes('--approve-for-me'));
  assert.equal(forms.includes('--dangerously-bypass-hook-trust'), false);
});

test('stripPermissionIntentFlags removes the flag with its value', () => {
  const stripped = stripPermissionIntentFlags('codex', [
    'resume', '--last', '-s', 'danger-full-access', '--ask-for-approval=never', '--dangerously-bypass-hook-trust'
  ]);
  assert.deepEqual(stripped.args, ['resume', '--last', '--dangerously-bypass-hook-trust']);
  assert.deepEqual(stripped.removed, ['-s', '--ask-for-approval']);
});

test('validatePermissionArgs rejects unknown flags, bad values and conflicts', () => {
  assert.deepEqual(
    validatePermissionArgs('claude', ['--permission-mode', 'plan']),
    { ok: true, unknown: [], conflicts: [] }
  );
  assert.equal(validatePermissionArgs('claude', ['--permission-mode', 'nope']).ok, false);
  assert.equal(validatePermissionArgs('claude', ['--not-a-flag']).unknown[0], '--not-a-flag');
  const conflict = validatePermissionArgs('kimi', ['--yolo', '--auto']);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflicts.length, 1);
});

test('describePermissionCatalog is renderable without provider knowledge on the client', () => {
  const described = describePermissionCatalog('codex');
  assert.equal(described.verifiedCliVersion, '0.163.0');
  assert.deepEqual(described.subcommandsBlockingPermissionOverrides, ['resume', 'fork']);
  const approveForMe = described.flags.find((item) => item.flag === '--approve-for-me');
  assert.equal(approveForMe.value, 'none');
  assert.deepEqual(approveForMe.aliases, []);
  assert.equal(approveForMe.description.length > 0, true);
  assert.equal(approveForMe.descriptionEn.length > 0, true);
  const sandbox = described.flags.find((item) => item.flag === '--sandbox');
  assert.deepEqual(sandbox.options, ['read-only', 'workspace-write', 'danger-full-access']);
  assert.ok(described.groups.approval);
  assert.equal(described.conflicts.length, 3);
});
