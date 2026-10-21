import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blockingSubcommands,
  describeSelectionCommand,
  disabledFlags,
  findSelectionConflicts,
  findSelectionOverrides,
  flagValueOptions,
  groupPermissionFlags,
  parsePermissionArgs,
  serializePermissionArgs,
  upsertSelection,
  removeSelection
} from './permission-catalog-view.ts';

// 目录形状与 lib/providers/permission-flag-catalog.js 的 describePermissionCatalog 一致。
// 这里刻意用一份小目录：前端逻辑不依赖具体 provider，只依赖目录结构。
const CATALOG = {
  verifiedCliVersion: '0.0.0',
  groups: { bypass: '全放行', approval: '审批', sandbox: '沙箱', policy: '策略文件' },
  flags: [
    {
      flag: '--sandbox',
      aliases: ['-s'],
      group: 'sandbox',
      groupLabel: '沙箱',
      value: 'value' as const,
      options: ['read-only', 'workspace-write', 'danger-full-access'],
      description: '沙箱策略',
      descriptionEn: 'sandbox policy',
      example: 'codex -s read-only',
      configEquivalent: 'sandbox_mode = "read-only"',
      note: ''
    },
    {
      flag: '--ask-for-approval',
      aliases: ['-a'],
      group: 'approval',
      groupLabel: '审批',
      value: 'value' as const,
      options: ['on-request', 'never'],
      description: '何时确认',
      descriptionEn: 'approval policy',
      example: 'codex -a never',
      configEquivalent: 'approval_policy = "never"',
      note: ''
    },
    {
      flag: '--approve-for-me',
      aliases: [],
      group: 'approval',
      groupLabel: '审批',
      value: 'none' as const,
      options: [],
      description: '自动复核',
      descriptionEn: 'auto review',
      example: 'codex --approve-for-me',
      configEquivalent: '',
      note: '与 --sandbox / --ask-for-approval 互斥'
    },
    {
      flag: '--policy',
      aliases: [],
      group: 'policy',
      groupLabel: '策略文件',
      value: 'list' as const,
      options: [],
      description: '策略目录',
      descriptionEn: 'policy files',
      example: 'codex --policy ./policy',
      configEquivalent: '',
      note: ''
    }
  ],
  conflicts: [
    { a: '--approve-for-me', b: '--ask-for-approval', message: '不能同时使用' },
    { a: '--approve-for-me', b: '--sandbox', message: '不能同时使用' }
  ],
  overrides: [],
  subcommandsWithoutApprovalFlag: ['exec'],
  subcommandsBlockingPermissionOverrides: ['resume', 'fork']
};

test('groupPermissionFlags keeps declared order and no provider knowledge', () => {
  const groups = groupPermissionFlags(CATALOG);
  assert.deepEqual(groups.map((group) => group.key), ['approval', 'sandbox', 'policy']);
  assert.deepEqual(groups[0].entries.map((entry) => entry.flag), [
    '--ask-for-approval',
    '--approve-for-me'
  ]);
  assert.equal(groups[0].label, '审批');
});

test('groupPermissionFlags tolerates an empty catalog', () => {
  assert.deepEqual(groupPermissionFlags(null), []);
});

test('parsePermissionArgs normalizes aliases and drops unknown tokens', () => {
  const selections = parsePermissionArgs(CATALOG, [
    '-s', 'read-only', '--ask-for-approval=never', '--unknown-flag', '--approve-for-me'
  ]);
  assert.deepEqual(selections, [
    { flag: '--sandbox', value: 'read-only' },
    { flag: '--ask-for-approval', value: 'never' },
    { flag: '--approve-for-me', value: '' }
  ]);
});

test('serializePermissionArgs emits stable canonical order', () => {
  const selections = [
    { flag: '--policy', value: './policy' },
    { flag: '--sandbox', value: 'read-only' }
  ];
  assert.deepEqual(serializePermissionArgs(CATALOG, selections), [
    '--sandbox', 'read-only', '--policy', './policy'
  ]);
});

test('serializePermissionArgs round-trips through parse', () => {
  const tokens = ['--sandbox', 'workspace-write', '--approve-for-me'];
  assert.deepEqual(
    serializePermissionArgs(CATALOG, parsePermissionArgs(CATALOG, tokens)),
    tokens
  );
});

test('disabledFlags blocks the other half of every conflict in both directions', () => {
  const withApproveForMe = disabledFlags(CATALOG, [{ flag: '--approve-for-me', value: '' }]);
  assert.equal(withApproveForMe.has('--sandbox'), true);
  assert.equal(withApproveForMe.has('--ask-for-approval'), true);

  // 反过来：先选 sandbox，则 --approve-for-me 也禁用
  const withSandbox = disabledFlags(CATALOG, [{ flag: '--sandbox', value: 'read-only' }]);
  assert.equal(withSandbox.has('--approve-for-me'), true);
  assert.equal(withSandbox.has('--ask-for-approval'), false);
});

test('findSelectionConflicts surfaces a stale mutually exclusive pair', () => {
  const conflicts = findSelectionConflicts(CATALOG, [
    { flag: '--approve-for-me', value: '' },
    { flag: '--sandbox', value: 'read-only' }
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(findSelectionConflicts(CATALOG, [{ flag: '--sandbox', value: 'read-only' }]).length, 0);
});

test('findSelectionOverrides only reports (never blocks)', () => {
  const catalog = {
    ...CATALOG,
    overrides: [{ by: '--sandbox', over: '--policy', message: '后者被覆盖' }]
  };
  assert.equal(
    findSelectionOverrides(catalog, [
      { flag: '--sandbox', value: 'read-only' },
      { flag: '--policy', value: './p' }
    ]).length,
    1
  );
});

test('upsertSelection replaces rather than duplicating', () => {
  const once = upsertSelection([], '--sandbox', 'read-only');
  const twice = upsertSelection(once, '--sandbox', 'workspace-write');
  assert.deepEqual(twice, [{ flag: '--sandbox', value: 'workspace-write' }]);
  assert.deepEqual(removeSelection(twice, '--sandbox'), []);
});

test('flagValueOptions distinguishes enums from free-form values', () => {
  const sandbox = CATALOG.flags[0];
  const policy = CATALOG.flags[3];
  assert.deepEqual(flagValueOptions(sandbox), {
    options: ['read-only', 'workspace-write', 'danger-full-access'],
    freeform: false
  });
  assert.deepEqual(flagValueOptions(policy), { options: [], freeform: true });
  assert.deepEqual(flagValueOptions(CATALOG.flags[2]), { options: [], freeform: false });
});

test('describeSelectionCommand renders a copyable example', () => {
  assert.equal(
    describeSelectionCommand('codex', [
      { flag: '--sandbox', value: 'danger-full-access' },
      { flag: '--ask-for-approval', value: 'never' }
    ]),
    'codex --sandbox danger-full-access --ask-for-approval never'
  );
  assert.equal(describeSelectionCommand('codex', []), 'codex');
});

test('blockingSubcommands reads the version restriction from the catalog', () => {
  assert.deepEqual(blockingSubcommands(CATALOG), ['resume', 'fork']);
  assert.deepEqual(blockingSubcommands(null), []);
});
