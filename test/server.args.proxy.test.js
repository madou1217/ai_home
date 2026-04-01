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
