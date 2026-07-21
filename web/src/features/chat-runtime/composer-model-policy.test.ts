import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveComposerModelSelection } from './composer-model-policy';

const catalog = {
  models: [
    {
      id: 'gpt-5.6-sol', label: '5.6 Sol', supportedEfforts: ['medium', 'high'],
      defaultEffort: 'medium',
    },
    {
      id: 'gpt-5.6-terra', label: '5.6 Terra', supportedEfforts: ['low', 'high'],
      defaultEffort: 'high',
    },
  ],
  defaultModel: 'gpt-5.6-sol',
} as const;

test('composer selection uses provider defaults when no explicit choice exists', () => {
  assert.deepEqual(resolveComposerModelSelection(catalog, '', ''), {
    model: 'gpt-5.6-sol', effort: 'medium',
  });
});

test('composer selection preserves supported explicit model effort', () => {
  assert.deepEqual(resolveComposerModelSelection(catalog, 'gpt-5.6-terra', 'low'), {
    model: 'gpt-5.6-terra', effort: 'low',
  });
});

test('composer selection resets stale model and unsupported effort to actual provider defaults', () => {
  assert.deepEqual(resolveComposerModelSelection(catalog, 'removed-model', 'ultra'), {
    model: 'gpt-5.6-sol', effort: 'medium',
  });
  assert.deepEqual(resolveComposerModelSelection(catalog, 'gpt-5.6-terra', 'medium'), {
    model: 'gpt-5.6-terra', effort: 'high',
  });
});
