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
  const groups = buildComposerModelGroups(OPENCODE_MODELS, { query: '', chip: 'all' });
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
  const groups = buildComposerModelGroups(models, { query: '', chip: 'all' });
  assert.deepEqual(groups.map((group) => group.id), ['all']);
  assert.deepEqual(groups[0].models.map((model) => model.id), ['gpt-5.5', 'claude-opus-4-6']);
});

test('search matches id or label case-insensitively and keeps the group shape', () => {
  const groups = buildComposerModelGroups(OPENCODE_MODELS, { query: 'DEEPSEEK', chip: 'all' });
  assert.deepEqual(groups.flatMap((group) => group.models.map((model) => model.id)), [
    'opencode/deepseek-v4.1-flash-free',
    'opencode-go/deepseek-v4-pro',
  ]);
  assert.deepEqual(
    groups.map((group) => group.id),
    ['free', 'go'],
    '只剩命中的分组，空分组不渲染',
  );
  assert.deepEqual(buildComposerModelGroups(OPENCODE_MODELS, { query: 'nothing-matches', chip: 'all' }), []);
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
