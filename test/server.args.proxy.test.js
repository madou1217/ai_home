const test = require('node:test');
const assert = require('node:assert/strict');
const { parseServerServeArgs } = require('../lib/server/args');

function withEnv(patch, fn) {
  const keys = Object.keys(patch);
  const previous = {};
  keys.forEach((key) => {
    previous[key] = process.env[key];
    const value = patch[key];
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = String(value);
  });
  try {
    return fn();
  } finally {
    keys.forEach((key) => {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }
}

test('parseServerServeArgs loads proxy settings from env', () => {
  withEnv({
    AIH_SERVER_PROXY_URL: 'http://env-proxy:7890',
    AIH_SERVER_NO_PROXY: 'localhost,127.0.0.1',
    HTTPS_PROXY: undefined,
    https_proxy: undefined,
    HTTP_PROXY: undefined,
    http_proxy: undefined
  }, () => {
    const parsed = parseServerServeArgs([]);
    assert.equal(parsed.backend, 'codex-adapter');
    assert.equal(parsed.proxyUrl, 'http://env-proxy:7890');
    assert.equal(parsed.noProxy, 'localhost,127.0.0.1');
    assert.equal(parsed.effectiveConfig.proxyConfigured, true);
  });
});

test('parseServerServeArgs defaults AIH provider port to 9527', () => {
  withEnv({
    AIH_SERVER_PORT: undefined
  }, () => {
    const parsed = parseServerServeArgs([]);
    assert.equal(parsed.port, 9527);
    assert.equal(parsed.effectiveConfig.port, 9527);
  });
});

test('parseServerServeArgs allows CLI proxy overrides', () => {
  withEnv({
    AIH_SERVER_PROXY_URL: 'http://env-proxy:7890',
    AIH_SERVER_NO_PROXY: 'localhost'
  }, () => {
    const parsed = parseServerServeArgs([
      '--proxy-url', 'http://cli-proxy:9000',
      '--no-proxy', 'api.openai.com'
    ]);
    assert.equal(parsed.proxyUrl, 'http://cli-proxy:9000');
    assert.equal(parsed.noProxy, 'api.openai.com');
  });
});

test('parseServerServeArgs accepts codex client version override', () => {
  withEnv({
    AIH_SERVER_CODEX_CLIENT_VERSION: '0.129.0'
  }, () => {
    const fromEnv = parseServerServeArgs([]);
    assert.equal(fromEnv.codexClientVersion, '0.129.0');
  });

  const fromCli = parseServerServeArgs([
    '--codex-client-version', 'codex-cli 0.130.0'
  ]);
  assert.equal(fromCli.codexClientVersion, 'codex-cli 0.130.0');
});

test('parseServerServeArgs supports equals syntax for host, port and api key', () => {
  const parsed = parseServerServeArgs([
    '--host=0.0.0.0',
    '--port=11435',
    '--api-key=local-key'
  ]);
  assert.equal(parsed.host, '0.0.0.0');
  assert.equal(parsed.port, 11435);
  assert.equal(parsed.clientKey, 'local-key');
});

test('parseServerServeArgs does not restart Codex App server by default', () => {
  withEnv({
    AIH_SERVER_CODEX_DESKTOP_RESTART_APP_SERVER_ON_HOOK_CHANGE: undefined
  }, () => {
    const parsed = parseServerServeArgs([]);
    assert.equal(parsed.codexDesktopRestartAppServerOnHookChange, false);
  });

  withEnv({
    AIH_SERVER_CODEX_DESKTOP_RESTART_APP_SERVER_ON_HOOK_CHANGE: '1'
  }, () => {
    const parsed = parseServerServeArgs([]);
    assert.equal(parsed.codexDesktopRestartAppServerOnHookChange, true);
  });
});
