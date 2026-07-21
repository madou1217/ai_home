const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  detectAntigravityClientVersion,
  parseAntigravityVersion,
  resetAntigravityClientVersionCacheForTest
} = require('../lib/server/antigravity-version');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-antigravity-version-'));
}

test('parseAntigravityVersion extracts semantic version', () => {
  assert.equal(parseAntigravityVersion('Antigravity 2.0.6'), '2.0.6');
  assert.equal(parseAntigravityVersion('not-a-version'), '');
});

test('detectAntigravityClientVersion prefers explicit env override', () => {
  resetAntigravityClientVersionCacheForTest();
  assert.equal(detectAntigravityClientVersion({
    env: {
      AIH_ANTIGRAVITY_VERSION: 'Antigravity/2.1.3'
    },
    noCache: true
  }), '2.1.3');
});

test('detectAntigravityClientVersion reads macOS Info.plist version', () => {
  const root = mkTmpDir();
  try {
    resetAntigravityClientVersionCacheForTest();
    const appPath = path.join(root, 'Antigravity.app');
    const contentsDir = path.join(appPath, 'Contents');
    fs.mkdirSync(contentsDir, { recursive: true });
    fs.writeFileSync(path.join(contentsDir, 'Info.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '<dict>',
      '<key>CFBundleShortVersionString</key>',
      '<string>2.0.6</string>',
      '</dict>',
      '</plist>'
    ].join('\n'));

    assert.equal(detectAntigravityClientVersion({
      antigravityAppPath: appPath,
      env: {},
      noCache: true
    }, {
      execFileSync: () => {
        throw new Error('plistbuddy unavailable');
      }
    }), '2.0.6');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detectAntigravityClientVersion falls back to bundled package metadata', () => {
  const root = mkTmpDir();
  try {
    resetAntigravityClientVersionCacheForTest();
    const resourceDir = path.join(root, 'Antigravity.app', 'Contents', 'Resources', 'app');
    fs.mkdirSync(resourceDir, { recursive: true });
    fs.writeFileSync(path.join(resourceDir, 'package.json'), JSON.stringify({ version: '2.2.0' }));

    assert.equal(detectAntigravityClientVersion({
      antigravityAppPath: path.join(root, 'Antigravity.app'),
      env: {},
      noCache: true
    }, {
      execFileSync: () => {
        throw new Error('plistbuddy unavailable');
      }
    }), '2.2.0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
