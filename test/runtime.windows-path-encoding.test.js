const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeEncodedWindowsPath,
  normalizeWindowsPathForCodexConfig
} = require('../lib/runtime/windows-path-encoding');

test('decodeEncodedWindowsPath decodes Codex encoded Windows absolute paths', () => {
  const colon = String.fromCharCode(0xf03a);
  const backslash = String.fromCharCode(0xf05c);

  assert.equal(
    decodeEncodedWindowsPath(`C${colon}${backslash}Users${backslash}madou${backslash}.codex`),
    'C:\\Users\\madou\\.codex'
  );
});

test('normalizeWindowsPathForCodexConfig writes drive paths without backslashes', () => {
  assert.equal(
    normalizeWindowsPathForCodexConfig('C:\\Users\\madou\\.codex'),
    'C:/Users/madou/.codex'
  );
});

test('normalizeWindowsPathForCodexConfig decodes encoded Windows paths before TOML sync', () => {
  const colon = String.fromCharCode(0xf03a);
  const backslash = String.fromCharCode(0xf05c);

  assert.equal(
    normalizeWindowsPathForCodexConfig(
      `C${colon}${backslash}Users${backslash}madou${backslash}.codex`
    ),
    'C:/Users/madou/.codex'
  );
});

test('normalizeWindowsPathForCodexConfig leaves non-Windows paths unchanged', () => {
  assert.equal(normalizeWindowsPathForCodexConfig('/Users/model/.codex'), '/Users/model/.codex');
  assert.equal(normalizeWindowsPathForCodexConfig('relative\\path'), 'relative\\path');
});
