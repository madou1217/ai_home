'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SOURCE_FINGERPRINT_DIRECTORIES,
  SOURCE_FINGERPRINT_FILES,
  getSourceFingerprintPaths,
  isBackgroundSupervisorCommand,
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

test('source fingerprint parses the exact background supervisor command', () => {
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
    '/usr/local/bin/node /opt/homebrew/bin/aih __background run',
    { fs: fakeFs, path: path.posix }
  );
  assert.equal(entry, appEntryFilePath);
  assert.equal(isBackgroundSupervisorCommand(
    '/usr/local/bin/node /opt/homebrew/bin/aih __background run'
  ), true);
  assert.equal(parseServerEntryFilePathFromCommand(
    '/usr/local/bin/node /opt/homebrew/bin/aih __background run extra',
    { fs: fakeFs, path: path.posix }
  ), '');
  assert.equal(isBackgroundSupervisorCommand(
    '/usr/local/bin/node /opt/homebrew/bin/aih __background run extra'
  ), false);
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

test('source fingerprint includes the reverse fabric gateway boundary', () => {
  [
    'lib/cli/services/fabric/broker-connect.js',
    'lib/cli/services/fabric/broker-request-handler.js',
    'lib/cli/services/fabric/broker-websocket-handler.js',
    'lib/server/fabric-descriptor.js',
    'lib/server/fabric-gateway-capacity.js',
    'lib/server/fabric-gateway-capability.js',
    'lib/server/fabric-gateway-fallback.js',
    'lib/server/fabric-gateway-protocol.js',
    'lib/server/fabric-gateway-route.js',
    'lib/server/fabric-gateway-websocket.js',
    'lib/server/fabric-gateway-websocket-frames.js',
    'lib/server/fabric-gateway-websocket-session.js',
    'lib/server/outbound-relay-manager.js',
    'lib/server/v1-router.js'
  ].forEach((file) => {
    assert.equal(SOURCE_FINGERPRINT_FILES.includes(file), true);
  });
});

test('source fingerprint includes Codex canonical interaction boundary files', () => {
  [
    'lib/server/chat-runtime/canonical-interaction-payload.js',
    'lib/server/chat-runtime/codex-approval-request-adapter.js',
    'lib/server/chat-runtime/codex-interaction-adapter-support.js',
    'lib/server/chat-runtime/codex-interaction-request-adapter.js',
    'lib/server/chat-runtime/codex-mcp-elicitation-request-adapter.js',
    'lib/server/chat-runtime/codex-tool-question-request-adapter.js'
  ].forEach((file) => {
    assert.equal(SOURCE_FINGERPRINT_FILES.includes(file), true);
  });
});

test('source fingerprint recursively includes the canonical chat runtime boundary', () => {
  assert.deepEqual(SOURCE_FINGERPRINT_DIRECTORIES, ['lib/server/chat-runtime']);
  const entryFile = path.join(__dirname, '..', 'lib', 'cli', 'app.js');
  const relativePaths = getSourceFingerprintPaths(fs, path, entryFile)
    .map((item) => item.relativePath);
  assert.equal(relativePaths.includes('lib/server/chat-runtime/session-actor.js'), true);
  assert.equal(relativePaths.includes('lib/server/chat-runtime/canonical-diagnostic-sanitizer.js'), true);
  assert.equal(new Set(relativePaths).size, relativePaths.length);
});

test('source fingerprint includes canonical runtime composition and WebUI boundaries', () => {
  [
    'lib/server/chat-runtime-bootstrap.js',
    'lib/server/chat-runtime-composition.js',
    'lib/server/chat-runtime-service.js',
    'lib/server/codex-app-server-canonical.js',
    'lib/server/provider-runtime-metadata.js',
    'lib/server/webui-chat-runtime-routes.js',
    'lib/server/webui-chat-runtime-sse.js'
  ].forEach((file) => {
    assert.equal(SOURCE_FINGERPRINT_FILES.includes(file), true);
  });
});

test('source fingerprint includes native WebUI session runtime files', () => {
  [
    'lib/cli/services/ai-cli/codex-provider-args.js',
    'lib/server/codex-app-server-client-pool.js',
    'lib/server/codex-app-server-endpoint.js',
    'lib/server/codex-app-server-json-rpc-client.js',
    'lib/server/codex-app-server-legacy-runner.js',
    'lib/server/codex-app-server-runner.js',
    'lib/server/native-run-manifest.js',
    'lib/server/native-session-chat.js',
    'lib/server/webui-chat-routes.js'
  ].forEach((file) => {
    assert.equal(SOURCE_FINGERPRINT_FILES.includes(file), true);
  });
});
