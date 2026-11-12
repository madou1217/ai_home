'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const releaseTag = require('../scripts/release-tag');
const releaseCheck = require('../scripts/release-check');

test('release-tag: semver bumps and explicit versions', () => {
  assert.equal(releaseTag.nextVersion('1.2.3', { bump: 'patch' }), '1.2.4');
  assert.equal(releaseTag.nextVersion('1.2.3', { bump: 'minor' }), '1.3.0');
  assert.equal(releaseTag.nextVersion('1.2.3', { bump: 'major' }), '2.0.0');
  assert.equal(releaseTag.nextVersion('1.2.3', { version: '2.0.0' }), '2.0.0');
  assert.throws(() => releaseTag.nextVersion('1.2.3', { version: '1.2.3' }), /greater than/);
  assert.throws(() => releaseTag.nextVersion('1.2.3', { bump: 'nope' }), /cannot compute/);
});

test('release-tag: CLI requires exactly one of --bump / --version', () => {
  assert.deepEqual(releaseTag.parseArgs(['--bump', 'patch']).bump, 'patch');
  assert.deepEqual(releaseTag.parseArgs(['--version', '1.2.3']).version, '1.2.3');
  assert.throws(() => releaseTag.parseArgs([]), /one of/);
  assert.throws(() => releaseTag.parseArgs(['--bump', 'patch', '--version', '1.2.3']), /mutually exclusive/);
  assert.throws(() => releaseTag.parseArgs(['--bump', 'nope']), /patch, minor or major/);
  assert.throws(() => releaseTag.parseArgs(['--version', 'not-semver']), /invalid semver/);
});

test('release-check: parses tag/artifact options', () => {
  const options = releaseCheck.parseArgs(['--tag', 'v1.2.3', '--no-head', '--require-artifacts']);
  assert.equal(options.tag, 'v1.2.3');
  assert.equal(options.checkHead, false);
  assert.equal(options.requireArtifacts, true);
  assert.throws(() => releaseCheck.parseArgs(['--tag']), /requires a value/);
});

test('release-check: sha256 matches a file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-release-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'artifact.bin');
  fs.writeFileSync(file, 'hello');
  assert.equal(releaseCheck.sha256(file), crypto.createHash('sha256').update('hello').digest('hex'));
});
