'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  WEB_BUILD_MANIFEST,
  digestWebDist,
  prepareWebDist,
  parseArgs
} = require('../scripts/deploy-server');

function tempDist() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-dist-'));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(root, 'nested', 'app.js'), 'console.log(1);');
  return root;
}

test('digestWebDist is stable and changes when an artifact changes', () => {
  const root = tempDist();
  try {
    const first = digestWebDist(root);
    fs.writeFileSync(path.join(root, 'nested', 'app.js'), 'console.log(2);');
    const second = digestWebDist(root);
    assert.equal(first.file_count, 2);
    assert.notEqual(first.artifact_sha256, second.artifact_sha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepareWebDist records the deploy source SHA', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-worktree-'));
  const source = tempDist();
  try {
    fs.mkdirSync(path.join(root, 'web'), { recursive: true });
    prepareWebDist(root, { webDist: source, skipWebBuild: true }, 'abc123');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'web', 'dist', WEB_BUILD_MANIFEST), 'utf8'));
    assert.equal(manifest.source_sha, 'abc123');
    assert.equal(manifest.file_count, 2);
    assert.equal(fs.readFileSync(path.join(root, 'web', 'dist', 'nested', 'app.js'), 'utf8'), 'console.log(1);');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('deploy parser requires an explicit prebuilt artifact for skip-web-build', () => {
  assert.throws(() => parseArgs(['--ssh', 'ubuntu@host', '--skip-web-build']), /--skip-web-build/);
  const options = parseArgs(['--ssh', 'ubuntu@host', '--skip-web-build', '--web-dist', '/tmp/dist']);
  assert.equal(options.skipWebBuild, true);
  assert.equal(options.webDist, '/tmp/dist');
});
