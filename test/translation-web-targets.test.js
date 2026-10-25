'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const helperUrl = pathToFileURL(path.join(root, 'web/src/features/translation/translation-targets.ts')).href;

function evaluateHelper(expression) {
  const script = `import * as helpers from ${JSON.stringify(helperUrl)}; console.log(JSON.stringify(${expression}));`;
  return JSON.parse(execFileSync(process.execPath, ['--no-warnings', '--experimental-strip-types', '--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
  }));
}

test('translation target and provider status stays honest for configured, pending, and unavailable capabilities', () => {
  assert.deepEqual(evaluateHelper('helpers.getTranslationTargetStatus({ available: true, configured: true })'), {
    state: 'configured', label: '已配置', selectable: true
  });
  assert.deepEqual(evaluateHelper('helpers.getTranslationTargetStatus({ available: true, configured: false })'), {
    state: 'pending', label: '待配置', selectable: false
  });
  assert.deepEqual(evaluateHelper('helpers.getTranslationTargetStatus({ available: false, configured: true })'), {
    state: 'unavailable', label: '不可用', selectable: false
  });
  assert.deepEqual(evaluateHelper('helpers.getTranslationProviderStatus({ executable: false, configured: false })'), {
    state: 'unavailable', label: '不可用', selectable: false
  });
});

test('translation UI source has no full-page Alert or left-border decoration', () => {
  const root = path.resolve(__dirname, '../web/src/features/translation');
  const files = [
    'SystemTranslationControl.tsx',
    'TranslationProviderSettings.tsx',
    'TranslationWorkspace.tsx',
    'translation.module.css',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const expression = `helpers.hasForbiddenTranslationDecoration(${JSON.stringify(source)})`;
    assert.equal(evaluateHelper(expression), false, `${file} contains a forbidden Alert or left-border decoration`);
  }
});

test('page translation cleanup cannot clear a newer run state', () => {
  const workspace = fs.readFileSync(path.resolve(__dirname, '../web/src/features/translation/TranslationWorkspace.tsx'), 'utf8');
  assert.match(
    workspace,
    /if \(pageAbortRef\.current === controller\) \{\s*pageAbortRef\.current = null;\s*setPageBusy\(false\);\s*\}/,
  );
});
