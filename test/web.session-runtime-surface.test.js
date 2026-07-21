'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SURFACE_PATH = path.join(
  __dirname,
  '..',
  'web',
  'src',
  'features',
  'chat-runtime',
  'SessionRuntimeSurface.tsx'
);

test('canonical runtime errors do not render an account selector', () => {
  const source = fs.readFileSync(SURFACE_PATH, 'utf8');
  const runtimeState = source.slice(source.indexOf('function RuntimeState('));

  assert.doesNotMatch(runtimeState, /\bSelect\b|getAccountIdentityLabel|onAccountChange/);
  assert.match(source, /<SessionWorkspace[\s\S]*onAccountChange=\{props\.onAccountChange\}/);
});
