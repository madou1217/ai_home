'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TARGETS,
  artifactBaseName,
  hostTarget,
  nodeDistributionFile,
  parseTargets,
  targetKey
} = require('../scripts/package/targets');

test('target matrix covers the supported desktop platforms', () => {
  const keys = TARGETS.map(targetKey);
  for (const expected of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']) {
    assert.ok(keys.includes(expected), `${expected} must be a release target`);
  }
});

test('parseTargets defaults to the host and expands all', () => {
  const host = parseTargets('');
  assert.equal(host.length, 1);
  assert.equal(targetKey(host[0]), targetKey(hostTarget()));

  assert.equal(parseTargets('all').length, TARGETS.length);
  assert.equal(parseTargets('linux-x64').length, 1);
  assert.equal(targetKey(parseTargets('linux-x64')[0]), 'linux-x64');
  assert.equal(parseTargets('linux-x64,linux-x64').length, 1);
});

test('parseTargets rejects unknown entries instead of silently skipping them', () => {
  assert.throws(() => parseTargets('linux-mips'), /unknown --targets entry/);
});

test('nodeDistributionFile matches the official Node dist naming', () => {
  const darwin = TARGETS.find((target) => targetKey(target) === 'darwin-arm64');
  const windows = TARGETS.find((target) => targetKey(target) === 'win32-x64');
  assert.equal(nodeDistributionFile(darwin, '22.21.0'), 'node-v22.21.0-darwin-arm64.tar.gz');
  assert.equal(nodeDistributionFile(windows, 'v22.21.0'), 'node-v22.21.0-win-x64.zip');
});

test('artifactBaseName includes version and target', () => {
  const linux = TARGETS.find((target) => targetKey(target) === 'linux-arm64');
  assert.equal(artifactBaseName('1.2.3', linux), 'aih-1.2.3-linux-arm64');
});
