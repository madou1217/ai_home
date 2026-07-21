const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const composerModelMenuPath = path.join(
  __dirname,
  '../web/src/components/chat/composer/ComposerModelMenu.tsx'
);

test('composer model submenus rely on the menu hierarchy indicator only', () => {
  const source = fs.readFileSync(composerModelMenuPath, 'utf8');

  assert.doesNotMatch(source, /\bRightOutlined\b/u);
});
