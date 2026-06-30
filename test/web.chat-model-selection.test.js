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
