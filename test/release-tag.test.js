'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { nextVersion, parseArgs } = require('../scripts/release-tag');
const { assertTaggedRelease } = require('../scripts/package/build-release');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'release@example.test']);
  git(dir, ['config', 'user.name', 'Release Test']);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
  git(dir, ['add', 'package.json']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

test('nextVersion bumps semver and rejects downgrades', () => {
  assert.equal(nextVersion('1.2.3', { bump: 'patch' }), '1.2.4');
  assert.equal(nextVersion('1.2.3', { bump: 'minor' }), '1.3.0');
  assert.equal(nextVersion('1.2.3', { bump: 'major' }), '2.0.0');
  assert.equal(nextVersion('1.2.3', { version: '2.0.0' }), '2.0.0');
  assert.throws(() => nextVersion('1.2.3', { version: '1.2.3' }), /must be greater/);
});

test('release args require exactly one of --bump / --version', () => {
  assert.equal(parseArgs(['--bump', 'patch']).bump, 'patch');
  assert.equal(parseArgs(['--version', '1.2.3']).version, '1.2.3');
  assert.throws(() => parseArgs([]), /one of --bump/);
  assert.throws(() => parseArgs(['--bump', 'patch', '--version', '1.2.3']), /mutually exclusive/);
  assert.throws(() => parseArgs(['--bump', 'banana']), /patch, minor or major/);
});

test('assertTaggedRelease only accepts a clean HEAD with the exact v<version> tag', (t) => {
  const dir = repo(t);
  assert.throws(() => assertTaggedRelease(dir, '1.0.0'), /expected v1.0.0/);
  git(dir, ['tag', '-a', 'v1.0.0', '-m', 'release']);
  assert.doesNotThrow(() => assertTaggedRelease(dir, '1.0.0'));
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'dirty\n');
  assert.throws(() => assertTaggedRelease(dir, '1.0.0'), /clean working tree/);
});
