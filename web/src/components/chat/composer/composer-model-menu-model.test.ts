import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildComposerModelGroups,
  composerModelBucketOf,
  filterComposerModels,
  isOpenCodeModelCatalog,
} from './composer-model-menu-model';

const OPENCODE_MODELS = [
  { id: 'opencode-go/cat-jam-free', label: 'opencode-go/cat-jam-free' },
  { id: 'opencode-go/deepseek-v4-pro', label: 'opencode-go/deepseek-v4-pro' },
  { id: 'opencode/claude-opus-4-6', label: 'opencode/claude-opus-4-6' },
  { id: 'opencode/deepseek-v4.1-flash-free', label: 'opencode/deepseek-v4.1-flash-free' },
  { id: 'opencode/kimi-k3', label: 'opencode/kimi-k3' },
];

test('composer model buckets are mutually exclusive with free taking precedence', () => {
  assert.equal(composerModelBucketOf('opencode-go/cat-jam-free'), 'free');
  assert.equal(composerModelBucketOf('opencode/deepseek-v4.1-flash-free'), 'free');
  assert.equal(composerModelBucketOf('opencode-go/deepseek-v4-pro'), 'go');
  assert.equal(composerModelBucketOf('opencode/kimi-k3'), 'zen');
  assert.equal(composerModelBucketOf('gpt-5.5'), 'other');
});

test('opencode catalogs get free/zen/go sections in a fixed order without duplicates', () => {
  const groups = buildComposerModelGroups(OPENCODE_MODELS, { query: '', chip: 'all', openCodeCatalog: true });
  assert.deepEqual(groups.map((group) => [group.id, group.label]), [
    ['free', '免费模型'],
    ['zen', 'OpenCode Zen'],
    ['go', 'OpenCode Go'],
  ]);
  const ids = groups.flatMap((group) => group.models.map((model) => model.id));
  assert.equal(ids.length, OPENCODE_MODELS.length, '每个模型只能出现在一个分组里');
  assert.deepEqual(
    groups.find((group) => group.id === 'free')?.models.map((model) => model.id),
    ['opencode-go/cat-jam-free', 'opencode/deepseek-v4.1-flash-free'],
  );
});

test('non-opencode catalogs keep a single section and keep server order', () => {
  const models = [
    { id: 'gpt-5.5', label: 'gpt-5.5' },
    { id: 'claude-opus-4-6', label: 'claude-opus-4-6' },
  ];
  assert.equal(isOpenCodeModelCatalog(models), false);
  const groups = buildComposerModelGroups(models, { query: '', chip: 'all', openCodeCatalog: false });
  assert.deepEqual(groups.map((group) => group.id), ['all']);
  assert.deepEqual(groups[0].models.map((model) => model.id), ['gpt-5.5', 'claude-opus-4-6']);
});

test('search matches id or label case-insensitively and keeps the group shape', () => {
  const groups = buildComposerModelGroups(OPENCODE_MODELS, { query: 'DEEPSEEK', chip: 'all', openCodeCatalog: true });
  assert.deepEqual(groups.flatMap((group) => group.models.map((model) => model.id)), [
    'opencode/deepseek-v4.1-flash-free',
    'opencode-go/deepseek-v4-pro',
  ]);
  assert.deepEqual(
    groups.map((group) => group.id),
    ['free', 'go'],
    '只剩命中的分组，空分组不渲染',
  );
  assert.deepEqual(buildComposerModelGroups(OPENCODE_MODELS, { query: 'nothing-matches', chip: 'all', openCodeCatalog: true }), []);
});

test('free chip uses the shared model-page predicate (overlapping with zen/go)', () => {
  // 芯片语义必须和模型页一致：free = 以 -free 结尾（含 go 命名空间），zen = opencode/*。
  const free = filterComposerModels(OPENCODE_MODELS, { query: '', chip: 'free' });
  assert.deepEqual(free.map((model) => model.id), [
    'opencode-go/cat-jam-free',
    'opencode/deepseek-v4.1-flash-free',
  ]);
  const zen = filterComposerModels(OPENCODE_MODELS, { query: '', chip: 'zen' });
  assert.deepEqual(zen.map((model) => model.id), [
    'opencode/claude-opus-4-6',
    'opencode/deepseek-v4.1-flash-free',
    'opencode/kimi-k3',
  ]);
  const go = filterComposerModels(OPENCODE_MODELS, { query: '', chip: 'go' });
  assert.deepEqual(go.map((model) => model.id), ['opencode-go/cat-jam-free', 'opencode-go/deepseek-v4-pro']);
});

// 2026-10-21 真机反馈：选中 aih-server 目标时，模型列表被套上了 OpenCode 专属分组
// （免费/Zen/Go 芯片 + 「其他模型」分组），看起来像「选了 aih-server 却全是 opencode
// 模型」。根因是分组开关从**目录内容**反推 —— aih-server 拿到的是全量网关目录，
// 必然含 opencode 命名空间模型。分组必须由调用方按**选中目标**声明。
test('跨 provider 的全量目录不因含 opencode 模型而被套上 OpenCode 分组', () => {
  const gatewayModels = [
    ...OPENCODE_MODELS,
    { id: 'gpt-5.5', label: 'gpt-5.5' },
    { id: 'claude-opus-5-5', label: 'claude-opus-5-5' },
  ];
  // 目录内容确实含 opencode 模型（这是事实判断，仍为 true）。
  assert.equal(isOpenCodeModelCatalog(gatewayModels), true);
  // 但目标不是 opencode → 单一「全部模型」分组，与目录内容无关。
  const groups = buildComposerModelGroups(gatewayModels, { query: '', chip: 'all', openCodeCatalog: false });
  assert.deepEqual(groups.map((group) => group.id), ['all']);
  assert.deepEqual(groups[0].models.map((model) => model.id), gatewayModels.map((model) => model.id));
});
