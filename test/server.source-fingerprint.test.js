'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  SOURCE_FINGERPRINT_FILES,
  parseServerEntryFilePathFromCommand
} = require('../lib/server/source-fingerprint');

test('source fingerprint parses real node server serve command', () => {
  const entry = parseServerEntryFilePathFromCommand(
    '/usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 9527'
  );
  assert.equal(entry, '/repo/lib/cli/app.js');
});

test('source fingerprint parses global aih shim server command', () => {
  const appEntryFilePath = '/opt/homebrew/lib/node_modules/ai_home/lib/cli/app.js';
  const fakeFs = {
    realpathSync(filePath) {
      if (filePath === '/opt/homebrew/bin/aih') {
        return '/opt/homebrew/lib/node_modules/ai_home/bin/ai-home.js';
      }
      return filePath;
    },
    existsSync(filePath) {
      return filePath === appEntryFilePath;
    }
  };
  const entry = parseServerEntryFilePathFromCommand(
    '/usr/local/bin/node /opt/homebrew/bin/aih server serve --host 127.0.0.1 --port 9527',
    { fs: fakeFs, path: path.posix }
  );
  assert.equal(entry, appEntryFilePath);
});

test('source fingerprint ignores unrelated process text containing historical server command', () => {
  const entry = parseServerEntryFilePathFromCommand(
    '/Applications/Codex.app/Contents/MacOS/Codex turn-ended {"output":"17994 /usr/local/bin/node /repo/lib/cli/app.js server serve --port 9527"}'
  );
  assert.equal(entry, '');
});

test('source fingerprint excludes deprecated AGY CLI transport from runtime boundary', () => {
  assert.equal(SOURCE_FINGERPRINT_FILES.includes('lib/server/agy-cli-transport.js'), false);
});

test('source fingerprint includes protocol boundary files', () => {
  [
    'lib/server/code-assist-anthropic-adapter.js',
    'lib/server/code-assist-provider-strategy.js',
    'lib/server/openai-chat-sse.js',
    'lib/server/provider-protocol-routing.js',
    'lib/server/protocol-adapters.js',
    'lib/server/protocol-fallback-bridge.js',
    'lib/server/protocol-request-adapter-registry.js'
  ].forEach((file) => {
    assert.equal(SOURCE_FINGERPRINT_FILES.includes(file), true);
  });
});
