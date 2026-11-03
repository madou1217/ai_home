'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectInstallSource } = require('../lib/cli/services/update/self-update');

test('detectInstallSource recognizes a packaged install before npm heuristics', () => {
  const source = detectInstallSource('ai-home', {
    env: { AIH_PACKAGED: '1', npm_config_user_agent: 'npm/10.0.0' },
    argv: ['node', '/opt/aih/bin/ai-home.js']
  });
  assert.equal(source, 'package');
});

test('detectInstallSource still recognizes npm installs', () => {
  const source = detectInstallSource('ai-home', {
    env: { npm_config_user_agent: 'npm/10.0.0' },
    argv: ['node', '/usr/lib/node_modules/ai-home/bin/ai-home.js']
  });
  assert.equal(source, 'npm');
});
