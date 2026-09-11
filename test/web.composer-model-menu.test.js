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

test('narrow desktop composer icon-collapses ungrouped controls but keeps grouped labels', () => {
  const controlsCss = fs.readFileSync(composerControlsCssPath, 'utf8');
  const runtimeCss = fs.readFileSync(runtimeCssPath, 'utf8');

  assert.match(runtimeCss, /\.composerToolbar\s*\{[^}]*container-type:\s*inline-size;/su);
  assert.match(controlsCss, /@container\s*\(max-width:\s*620px\)/u);
  // Hidden at <=620px: inline hints only, never the grouped account value.
  assert.match(controlsCss, /\.controlButton small,\s*\.approvalLabel,\s*\.modelEffort,\s*\.chevron\s*\{\s*display:\s*none;/su);
  // Ungrouped controls collapse to 32px icon squares.
  assert.match(controlsCss, /\.approvalButton,\s*\.modelSummary:not\(\[data-grouped='true'\]\)\s*\{[^}]*width:\s*32px;[^}]*flex:\s*0 0 32px;/su);
  // Grouped controls keep their labels with bounded truncation instead.
  assert.match(controlsCss, /\.controlButton\[data-grouped='true'\]\s*\.controlValue\s*\{\s*display:\s*inline;/su);
  assert.match(controlsCss, /@container\s*\(max-width:\s*420px\)[^]*\.modelSummary\[data-grouped='true'\]\s*\.modelIcon\s*\{\s*display:\s*none;/su);
});

test('composer brain icon has the same fixed size as toolbar icons', () => {
  const source = fs.readFileSync(composerModelMenuPath, 'utf8');
  const controlsCss = fs.readFileSync(composerControlsCssPath, 'utf8');

  assert.match(source, /<BrainIcon className=\{styles\.modelIcon\}\s*\/>/u);
  assert.match(controlsCss, /\.modelIcon\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*flex:\s*0 0 16px;/su);
});
