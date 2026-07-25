const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const composerModelMenuPath = path.join(
  __dirname,
  '../web/src/components/chat/composer/ComposerModelMenu.tsx'
);
const composerControlsCssPath = path.join(
  __dirname,
  '../web/src/components/chat/composer/composer-controls.module.css'
);
const runtimeCssPath = path.join(
  __dirname,
  '../web/src/features/chat-runtime/session-runtime.module.css'
);

test('composer model submenus rely on the menu hierarchy indicator only', () => {
  const source = fs.readFileSync(composerModelMenuPath, 'utf8');

  assert.doesNotMatch(source, /\bRightOutlined\b/u);
});

test('narrow desktop composer collapses account, approval, and model controls to icons', () => {
  const controlsCss = fs.readFileSync(composerControlsCssPath, 'utf8');
  const runtimeCss = fs.readFileSync(runtimeCssPath, 'utf8');

  assert.match(runtimeCss, /\.composerToolbar\s*\{[^}]*container-type:\s*inline-size;/su);
  assert.match(controlsCss, /@container\s*\(max-width:\s*620px\)/u);
  assert.match(controlsCss, /\.controlValue,\s*\.controlButton small,\s*\.approvalLabel,\s*\.modelLabel,\s*\.modelEffort,\s*\.chevron\s*\{\s*display:\s*none;/su);
  assert.match(controlsCss, /\.controlButton,\s*\.approvalButton,\s*\.modelSummary\s*\{[^}]*width:\s*30px;[^}]*flex:\s*0 0 30px;/su);
});

test('composer brain icon has the same fixed size as toolbar icons', () => {
  const source = fs.readFileSync(composerModelMenuPath, 'utf8');
  const controlsCss = fs.readFileSync(composerControlsCssPath, 'utf8');

  assert.match(source, /<BrainIcon className=\{styles\.modelIcon\}\s*\/>/u);
  assert.match(controlsCss, /\.modelIcon\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*flex:\s*0 0 16px;/su);
});
