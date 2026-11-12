'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pruneLockfile, prepareManifest } = require('../scripts/package/modules');
const { renderSource } = require('../scripts/package/sfx');
const { POSIX_INSTALLER, POSIX_LAUNCHER } = require('../scripts/package/bundle');
const { sha256Tree } = require('../scripts/package/fs-utils');

test('pruneLockfile removes the excluded codex packages without touching the rest', () => {
  const lock = {
    packages: {
      '': { dependencies: { '@openai/codex': '^0.142.3', ssh2: '1.17.0' } },
      'node_modules/@openai/codex': { version: '0.142.3' },
      'node_modules/@openai/codex-darwin-arm64': { version: '0.142.3' },
      'node_modules/ssh2': { version: '1.17.0' }
    }
  };
  pruneLockfile(lock);
  assert.equal(lock.packages[''].dependencies['@openai/codex'], undefined);
  assert.equal(lock.packages[''].dependencies.ssh2, '1.17.0');
  assert.equal(lock.packages['node_modules/@openai/codex'], undefined);
  assert.equal(lock.packages['node_modules/@openai/codex-darwin-arm64'], undefined);
  assert.ok(lock.packages['node_modules/ssh2']);
});

test('prepareManifest drops postinstall and the bundled codex dependency', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-manifest-'));
  const staging = path.join(root, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'ai-home',
      version: '1.0.0',
      scripts: { postinstall: 'node scripts/postinstall.js', build: 'x' },
      dependencies: { '@openai/codex': '1.0.0', ssh2: '1.0.0' }
    }));
    const result = prepareManifest(root, staging);
    assert.equal(result.hasLockfile, false);
    const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8'));
    assert.equal(manifest.scripts.postinstall, undefined);
    assert.equal(manifest.scripts.build, 'x');
    assert.equal(manifest.dependencies['@openai/codex'], undefined);
    assert.equal(manifest.dependencies.ssh2, '1.0.0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SFX source rendering replaces every build token', () => {
  const source = 'version=__AIH_BUNDLE_VERSION__, target=__AIH_BUNDLE_TARGET__, sha=__AIH_PAYLOAD_SHA__';
  const rendered = renderSource(source, {
    version: '1.2.3',
    target: { platform: 'linux', arch: 'x64' },
    payloadSha: 'a'.repeat(64)
  });
  assert.equal(rendered, 'version=1.2.3, target=linux-x64, sha=' + 'a'.repeat(64));
});

test('packaged launchers point at the bundled runtime and versioned installer', () => {
  assert.match(POSIX_LAUNCHER, /runtime\/bin\/node/);
  assert.match(POSIX_LAUNCHER, /AIH_EXECUTABLE="\$DIR\/aih"/);
  assert.match(POSIX_LAUNCHER, /AIH_CLI_PATH="\$AIH_EXECUTABLE"/);
  assert.match(POSIX_INSTALLER, /__AIH_VERSION__/);
  assert.match(POSIX_INSTALLER, /ln -sfn "\$INSTALL_DIR\/aih"/);
});

test('sha256Tree is stable and changes with content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-tree-'));
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'index.html'), 'a');
    fs.writeFileSync(path.join(root, 'nested', 'app.js'), 'b');
    const first = sha256Tree(root);
    const second = sha256Tree(root);
    assert.deepEqual(first, second);
    fs.writeFileSync(path.join(root, 'nested', 'app.js'), 'c');
    assert.notEqual(first.sha256, sha256Tree(root).sha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
