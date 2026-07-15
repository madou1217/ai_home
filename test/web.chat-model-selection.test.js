const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadAccountModelSelection() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'account-model-selection.js'
  )).href;
  return import(modulePath);
}

test('chat model selector uses only the selected account model projection', async () => {
  const { listAccountEnabledModels } = await loadAccountModelSelection();

  const selectedModels = listAccountEnabledModels({
    models: {
      codex: ['all-codex-model', 'selected-account-model', 'other-account-model']
    },
    byAccountRef: {
      acct_selected: ['selected-account-model', 'selected-account-model', ' '],
      acct_other: ['other-account-model']
    }
  }, 'acct_selected');

  assert.deepEqual(selectedModels, ['selected-account-model']);
});

test('chat model selector does not fall back to provider models without account projection', async () => {
  const { listAccountEnabledModels } = await loadAccountModelSelection();

  const selectedModels = listAccountEnabledModels({
    models: {
      codex: ['provider-wide-model']
    },
    byAccountRef: {}
  }, 'acct_missing');

  assert.deepEqual(selectedModels, []);
});

test('chat model selector prefers selectable account projection and exposes default model', async () => {
  const { getAccountDefaultModel, listAccountEnabledModels } = await loadAccountModelSelection();

  const catalog = {
    byAccountRef: {
      acct_selected: ['disabled-model', 'default-model', 'manual-model']
    },
    selectableByAccountRef: {
      acct_selected: ['default-model', 'manual-model']
    },
    defaultByAccountRef: {
      acct_selected: 'default-model'
    }
  };

  assert.deepEqual(listAccountEnabledModels(catalog, 'acct_selected'), ['default-model', 'manual-model']);
  assert.equal(getAccountDefaultModel(catalog, 'acct_selected'), 'default-model');
});

test('effective model keeps the user selection when it is in the account catalog', async () => {
  const { resolveEffectiveSelectedModel } = await loadAccountModelSelection();
  assert.equal(
    resolveEffectiveSelectedModel('gpt-b', ['gpt-a', 'gpt-b', 'gpt-c']),
    'gpt-b'
  );
});

test('effective model drops a stale model from a previous account and falls back to the first available', async () => {
  const { resolveEffectiveSelectedModel } = await loadAccountModelSelection();
  // 切账号后 selectedModel 还是上一个账号(claude)的模型，但当前账号只有 codex 模型：
  // 绝不能把 claude 模型当成"已选中"，应退回当前账号第一个可选模型。
  assert.equal(
    resolveEffectiveSelectedModel('claude-sonnet', ['gpt-a', 'gpt-b']),
    'gpt-a'
  );
});

test('effective model is empty while the account catalog is still loading/empty', async () => {
  const { resolveEffectiveSelectedModel } = await loadAccountModelSelection();
  // 目录为空(加载中/该账号无模型)：返回空串，交给 loading/empty 提示兜底，
  // 而不是残留旧账号模型让下拉看起来"可选"。
  assert.equal(resolveEffectiveSelectedModel('claude-sonnet', []), '');
  assert.equal(resolveEffectiveSelectedModel('', []), '');
});

test('chat model selector ignores default model outside selectable projection', async () => {
  const { getAccountDefaultModel } = await loadAccountModelSelection();

  assert.equal(getAccountDefaultModel({
    selectableByAccountRef: {
      acct_selected: ['enabled-model']
    },
    defaultByAccountRef: {
      acct_selected: 'disabled-model'
    }
  }, 'acct_selected'), '');
});
