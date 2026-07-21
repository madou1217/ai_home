'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleWebUiFrpConfigRoutes
} = require('../lib/server/webui-frp-config-routes');

function createContext(options = {}) {
  const writes = [];
  const headers = {};
  return {
    writes,
    headers,
    context: {
      method: options.method || 'GET',
      pathname: options.pathname || '/v0/webui/server-routes/frp/status',
      req: {
        headers: { host: 'aws.example.com', 'x-forwarded-proto': 'https' }
      },
      res: {
        setHeader(name, value) { headers[String(name).toLowerCase()] = value; }
      },
      deps: {
        aiHomeDir: '/tmp/aih',
        readRequestBody: async () => Buffer.from(JSON.stringify(options.payload || {})),
        writeJson(_res, statusCode, payload) { writes.push({ statusCode, payload }); },
        frpVisitorVerifyRetryDelayMs: 0,
        verifyFrpVisitorIdentity: async (visitor) => ({
          ok: true,
          stableServerId: visitor.stableServerId
        }),
        ...options.deps
      }
    }
  };
}

test('FRP status auto-discovers frpc without exposing its absolute config path', async () => {
  const fixture = createContext({
    deps: {
      discoverFrpcConfigPath: () => '/opt/homebrew/etc/frp/frpc.toml',
      listFrpVisitorRoutes: () => [{ stableServerId: 'server-home', name: 'Home', bindPort: 19527 }]
    }
  });

  assert.equal(await handleWebUiFrpConfigRoutes(fixture.context), true);
  assert.deepEqual(fixture.writes, [{
    statusCode: 200,
    payload: {
      ok: true,
      available: true,
      configFileName: 'frpc.toml',
      visitors: [{ stableServerId: 'server-home', name: 'Home', bindPort: 19527 }]
    }
  }]);
  assert.equal(JSON.stringify(fixture.writes).includes('/opt/homebrew'), false);
});

test('FRP provider apply forwards a secret once and returns only a redacted report', async () => {
  const calls = [];
  const fixture = createContext({
    method: 'POST',
    pathname: '/v0/webui/server-routes/frp/apply',
    payload: {
      role: 'provider',
      stableServerId: 'server-home',
      serverName: 'Home',
      secretKey: 'stcp-shared-secret',
      localPort: 9527
    },
    deps: {
      applyAihFrpConfig: async (input) => {
        calls.push(input);
        return {
          ok: true,
          action: 'restart',
          configPath: '/opt/homebrew/etc/frp/frpc.toml',
          fragmentPath: '/Users/tester/.ai_home/frp/frpc.d/aih.toml',
          serverId: input.serverId,
          role: input.role,
          proxyName: 'aih-local-server-home',
          changes: { main: true, fragment: true, permissions: true }
        };
      }
    }
  });

  assert.equal(await handleWebUiFrpConfigRoutes(fixture.context), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].secretKey, 'stcp-shared-secret');
  assert.equal(calls[0].aiHomeDir, '/tmp/aih');
  assert.deepEqual(fixture.writes, [{
    statusCode: 200,
    payload: {
      ok: true,
      role: 'provider',
      stableServerId: 'server-home',
      action: 'restart',
      bindPort: 0,
      changes: { main: true, fragment: true, permissions: true }
    }
  }]);
  assert.equal(JSON.stringify(fixture.writes).includes('stcp-shared-secret'), false);
  assert.equal(JSON.stringify(fixture.writes).includes('/opt/homebrew'), false);
  assert.equal(fixture.headers['cache-control'], 'no-store');
});

test('FRP visitor apply registers one secret-free route for the target Server', async () => {
  const registered = [];
  const fixture = createContext({
    method: 'POST',
    pathname: '/v0/webui/server-routes/frp/apply',
    payload: {
      role: 'visitor',
      stableServerId: 'server-home',
      serverName: 'Home',
      secretKey: 'stcp-shared-secret',
      bindPort: 19527
    },
    deps: {
      applyAihFrpConfig: async (options) => {
        await options.validateActivation();
        return {
          ok: true,
          action: 'reload',
          role: 'visitor',
          serverId: 'server-home',
          changes: { main: false, fragment: true, permissions: false }
        };
      },
      saveFrpVisitorRoute: (route) => {
        registered.push(route);
        return route;
      }
    }
  });

  assert.equal(await handleWebUiFrpConfigRoutes(fixture.context), true);
  assert.deepEqual(registered, [{
    stableServerId: 'server-home',
    name: 'Home',
    bindPort: 19527,
    health: 'healthy'
  }]);
  assert.equal(JSON.stringify(registered).includes('stcp-shared-secret'), false);
});

test('FRP apply returns a safe error code without process stderr or secret text', async () => {
  const fixture = createContext({
    method: 'POST',
    pathname: '/v0/webui/server-routes/frp/apply',
    payload: {
      role: 'provider',
      stableServerId: 'server-home',
      secretKey: 'stcp-shared-secret'
    },
    deps: {
      applyAihFrpConfig: async () => {
        const error = new Error('verify failed: stcp-shared-secret');
        error.code = 'frp_verify_failed';
        error.stderr = 'stcp-shared-secret';
        throw error;
      }
    }
  });

  assert.equal(await handleWebUiFrpConfigRoutes(fixture.context), true);
  assert.deepEqual(fixture.writes, [{
    statusCode: 502,
    payload: {
      ok: false,
      error: 'frp_verify_failed',
      message: 'FRP 配置未能生效，已尝试恢复原配置。'
    }
  }]);
  assert.equal(JSON.stringify(fixture.writes).includes('stcp-shared-secret'), false);
});
