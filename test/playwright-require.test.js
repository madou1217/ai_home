'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildNpxPathCandidates,
  findPlaywrightModulePath
} = require('../scripts/playwright-require');

test('playwright resolver derives module path from npx PATH entry', () => {
  const nodeModulesDir = path.join(os.tmpdir(), 'aih-npx-example', 'node_modules');
  const env = {
    PATH: [
      path.join(nodeModulesDir, '.bin'),
      '/usr/bin'
    ].join(path.delimiter)
  };

  assert.deepEqual(buildNpxPathCandidates(env), [
    path.join(nodeModulesDir, 'playwright')
  ]);
});

test('playwright resolver finds package.json under npx PATH module root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-playwright-resolver-'));
  const moduleDir = path.join(root, 'node_modules', 'playwright');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'package.json'), '{"name":"playwright"}\n', 'utf8');

  const found = findPlaywrightModulePath({
    env: { PATH: path.join(root, 'node_modules', '.bin') },
    cwd: path.join(root, 'workspace'),
    homeDir: path.join(root, 'home')
  });

  assert.equal(found, moduleDir);
});
