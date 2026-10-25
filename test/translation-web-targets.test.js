'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadTargetHelpers() {
  return import('../web/src/features/translation/translation-targets.ts');
}

test('translation target and provider status stays honest for configured, pending, and unavailable capabilities', async () => {
  const { getTranslationProviderStatus, getTranslationTargetStatus } = await loadTargetHelpers();
  assert.deepEqual(getTranslationTargetStatus({ available: true, configured: true }), {
    state: 'configured', label: '已配置', selectable: true
  });
  assert.deepEqual(getTranslationTargetStatus({ available: true, configured: false }), {
    state: 'pending', label: '待配置', selectable: false
  });
  assert.deepEqual(getTranslationTargetStatus({ available: false, configured: true }), {
    state: 'unavailable', label: '不可用', selectable: false
  });
  assert.deepEqual(getTranslationProviderStatus({ executable: false, configured: false }), {
    state: 'unavailable', label: '不可用', selectable: false
  });
});

test('translation UI source has no full-page Alert or left-border decoration', async () => {
  const { hasForbiddenTranslationDecoration } = await loadTargetHelpers();
  const root = path.resolve(__dirname, '../web/src/features/translation');
  const files = [
    'SystemTranslationControl.tsx',
    'TranslationProviderSettings.tsx',
    'TranslationWorkspace.tsx',
    'translation.module.css',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(hasForbiddenTranslationDecoration(source), false, `${file} contains a forbidden Alert or left-border decoration`);
  }
});
