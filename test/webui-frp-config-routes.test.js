'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyAihFrpConfig
} = require('../lib/cli/services/fabric/frp-config-manager');

const {
  listManagedFrpRoutes,
  removeManagedFrpRoute,
  upsertManagedFrpRoute
} = require('../lib/server/frp-route-registry');
const {
  handleWebUiFrpConfigRoutes
} = require('../lib/server/webui-frp-config-routes');

function createStoreDeps() {
  const values = new Map();
  return {
    values,
    readJsonValue(_fs, _aiHomeDir, key) {
      return values.get(key) || null;
    },
    writeJsonValue(_fs, _aiHomeDir, key, value) {
      values.set(key, value);
      return true;
    }
  };
}

function createFrpFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-frp-route-transaction-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const configPath = path.join(root, 'frpc.toml');
  fs.writeFileSync(configPath, [
    'serverAddr = "frps.example.com"',
    'serverPort = 7000',
    ''
  ].join('\n'));
  return { aiHomeDir, configPath };
}

function successfulProcessResult() {
  return { status: 0, stdout: '', stderr: '' };
}

async function completeFakeApply(options, result) {
  if (typeof options.validateActivation === 'function') {
    try {
      await options.validateActivation();
    } catch (_error) {
      const error = new Error('activation validation failed');
      error.code = 'frp_activation_validation_failed';
      throw error;
    }
  }
  return result;
}

function createContext(method, pathname, payload, overrides = {}) {
  const writes = [];
  const headers = {};
  return {
    writes,
    headers,
    context: {
      method,
      pathname,
      options: { port: 9527 },
      req: {},
      res: {
        setHeader(name, value) {
          headers[String(name).toLowerCase()] = value;
        }
      },
      fs: {},
      readRequestBody: async () => payload === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(payload)),
      writeJson(_res, statusCode, body) {
        writes.push({ statusCode, body });
      },
      deps: {
        aiHomeDir: '/tmp/aih',
        frpVisitorVerifyRetryDelayMs: 0,
        verifyFrpVisitorIdentity: async (visitor) => ({
          ok: true,
          stableServerId: visitor.stableServerId
        }),
        ...overrides
      }
    }
  };
}

test('FRP route registry persists only secret-free visitor metadata', () => {
  const deps = createStoreDeps();
  const saved = upsertManagedFrpRoute({
    stableServerId: 'server-local-home',
    name: 'Local Home',
    bindPort: 19527,
    secretKey: 'must-never-persist'
  }, { fs: {}, aiHomeDir: '/tmp/aih' }, deps);

  assert.deepEqual(saved, {
    stableServerId: 'server-local-home',
    name: 'Local Home',
    bindPort: 19527,
    endpoint: 'http://127.0.0.1:19527',
    health: 'unknown',
    updatedAt: saved.updatedAt
  });
  assert.deepEqual(listManagedFrpRoutes({ fs: {}, aiHomeDir: '/tmp/aih' }, deps), [saved]);
  assert.equal(JSON.stringify([...deps.values.values()]).includes('must-never-persist'), false);
  assert.equal(removeManagedFrpRoute('server-local-home', { fs: {}, aiHomeDir: '/tmp/aih' }, deps), true);
  assert.deepEqual(listManagedFrpRoutes({ fs: {}, aiHomeDir: '/tmp/aih' }, deps), []);
});

test('FRP provider apply uses the current Server port and never echoes the secret', async () => {
  const calls = [];
  const request = createContext('POST', '/v0/webui/server-routes/frp/apply', {
    role: 'provider',
    stableServerId: 'server-local-home',
    secretKey: 'stcp-private-secret'
  }, {
    applyAihFrpConfig: async (options) => {
      calls.push(options);
      return {
        ok: true,
        action: 'restart',
        configPath: '/private/frpc.toml',
        fragmentPath: '/private/aih.toml',
        changes: { main: true, fragment: true, permissions: true }
      };
    }
  });

  assert.equal(await handleWebUiFrpConfigRoutes(request.context), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, 'provider');
  assert.equal(calls[0].serverId, 'server-local-home');
  assert.equal(calls[0].localPort, 9527);
  assert.equal(calls[0].secretKey, 'stcp-private-secret');
  assert.equal(Object.hasOwn(calls[0], 'configPath'), false);
  assert.deepEqual(request.writes, [{
    statusCode: 200,
    body: {
      ok: true,
      role: 'provider',
      stableServerId: 'server-local-home',
      action: 'restart',
      bindPort: 0,
      changes: { main: true, fragment: true, permissions: true }
    }
  }]);
  assert.equal(JSON.stringify(request.writes).includes('stcp-private-secret'), false);
  assert.equal(JSON.stringify(request.writes).includes('/private/'), false);
  assert.equal(request.headers['cache-control'], 'no-store');
});

test('FRP apply rejects non-canonical Server ids instead of normalizing them', async () => {
  for (const stableServerId of ['Server-local-home', ' server-local-home']) {
    const request = createContext('POST', '/v0/webui/server-routes/frp/apply', {
      role: 'provider',
      stableServerId,
      secretKey: 'stcp-private-secret'
    }, {
      applyAihFrpConfig: async () => {
        throw new Error('invalid input must not reach the config manager');
      }
    });

    assert.equal(await handleWebUiFrpConfigRoutes(request.context), true);
    assert.deepEqual(request.writes, [{
      statusCode: 400,
      body: { ok: false, error: 'invalid_frp_config_payload' }
    }]);
  }
});

test('FRP visitor apply registers a proxyable loopback route', async () => {
  const store = createStoreDeps();
  const calls = [];
  const request = createContext('POST', '/v0/webui/server-routes/frp/apply', {
    role: 'visitor',
    stableServerId: 'server-local-home',
    name: 'Local Home',
    bindPort: 19527,
    secretKey: 'stcp-private-secret'
  }, {
    ...store,
    applyAihFrpConfig: async (options) => {
      calls.push(options);
      return completeFakeApply(options, {
        ok: true,
        action: 'reload',
        changes: { main: false, fragment: true, permissions: false }
      });
    }
  });

  assert.equal(await handleWebUiFrpConfigRoutes(request.context), true);
  assert.equal(calls[0].role, 'visitor');
  assert.equal(calls[0].bindPort, 19527);
  assert.equal(request.writes[0].statusCode, 200);
  assert.equal(request.writes[0].body.bindPort, 19527);
  const routes = listManagedFrpRoutes({ fs: {}, aiHomeDir: '/tmp/aih' }, store);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].endpoint, 'http://127.0.0.1:19527');
});

test('FRP visitor apply allocates a loopback port when the Client omits one', async () => {
  const calls = [];
  const request = createContext('POST', '/v0/webui/server-routes/frp/apply', {
    role: 'visitor',
    stableServerId: 'server-local-home',
    name: 'Local Home',
    secretKey: 'stcp-private-secret'
  }, {
    allocateFrpVisitorPort: async (stableServerId) => {
      assert.equal(stableServerId, 'server-local-home');
      return 19588;
    },
    applyAihFrpConfig: async (options) => {
      calls.push(options);
      return completeFakeApply(options, { ok: true, action: 'reload', changes: {} });
    },
    saveFrpVisitorRoute: (route) => route
  });

  assert.equal(await handleWebUiFrpConfigRoutes(request.context), true);
  assert.equal(calls[0].bindPort, 19588);
  assert.equal(request.writes[0].body.bindPort, 19588);
});

test('FRP visitor apply verifies identity with bounded retries before saving a healthy route', async () => {
  const events = [];
  const verificationInputs = [];
  const savedRoutes = [];
  const request = createContext('POST', '/v0/webui/server-routes/frp/apply', {
    role: 'visitor',
    stableServerId: 'server-local-home',
    name: 'Local Home',
    bindPort: 19527,
    secretKey: 'stcp-private-secret'
  }, {
    frpVisitorVerifyMaxAttempts: 3,
    frpVisitorVerifyRetryDelayMs: 0,
    applyAihFrpConfig: async (options) => {
      events.push('apply');
      return completeFakeApply(options, {
        ok: true,
        action: 'reload',
        changes: { fragment: true }
      });
    },
    verifyFrpVisitorIdentity: async (visitor) => {
      events.push('verify');
      verificationInputs.push(visitor);
      assert.equal(visitor.stableServerId, 'server-local-home');
      assert.equal(visitor.bindPort, 19527);
      assert.equal(Object.hasOwn(visitor, 'endpoint'), false);
      assert.equal(JSON.stringify(visitor).includes('stcp-private-secret'), false);
      if (verificationInputs.length === 1) {
        const error = new Error('visitor is still starting');
        error.code = 'fabric_frp_server_identity_unavailable';
        throw error;
      }
      return { ok: true, stableServerId: visitor.stableServerId };
    },
    saveFrpVisitorRoute: (route) => {
      events.push('save');
      savedRoutes.push(route);
      return route;
    }
  });

  assert.equal(await handleWebUiFrpConfigRoutes(request.context), true);
  assert.deepEqual(events, ['apply', 'verify', 'verify', 'save']);
  assert.equal(verificationInputs.length, 2);
  assert.deepEqual(savedRoutes, [{
    stableServerId: 'server-local-home',
    name: 'Local Home',
    bindPort: 19527,
    health: 'healthy'
  }]);
  assert.equal(request.writes[0].statusCode, 200);
  assert.equal(JSON.stringify(request.writes).includes('stcp-private-secret'), false);
});

test('FRP visitor apply preserves an existing route after bounded identity verification failure', async () => {
  const store = createStoreDeps();
  const events = [];
  upsertManagedFrpRoute({
    stableServerId: 'server-local-home',
    name: 'Stale Local Home',
    bindPort: 19000,
    health: 'healthy'
  }, { fs: {}, aiHomeDir: '/tmp/aih' }, store);
  let verificationAttempts = 0;
  const request = createContext('POST', '/v0/webui/server-routes/frp/apply', {
    role: 'visitor',
    stableServerId: 'server-local-home',
    name: 'Local Home',
    bindPort: 19527,
    secretKey: 'stcp-private-secret'
  }, {
    ...store,
    frpVisitorVerifyMaxAttempts: 2,
    frpVisitorVerifyRetryDelayMs: 0,
    applyAihFrpConfig: async (options) => {
      events.push('apply');
      return completeFakeApply(options, {
        ok: true,
        action: 'reload',
        changes: { fragment: true }
      });
    },
    verifyFrpVisitorIdentity: async (visitor) => {
      events.push('verify');
      verificationAttempts += 1;
      assert.equal(visitor.stableServerId, 'server-local-home');
      assert.equal(visitor.bindPort, 19527);
      const error = new Error(
        'identity unavailable at http://127.0.0.1:19527 using stcp-private-secret'
      );
      error.code = 'fabric_frp_server_identity_unavailable';
      throw error;
    }
  });

  assert.equal(await handleWebUiFrpConfigRoutes(request.context), true);
  assert.equal(verificationAttempts, 2);
  assert.deepEqual(events, ['apply', 'verify', 'verify']);
  assert.equal(
    listManagedFrpRoutes({ fs: {}, aiHomeDir: '/tmp/aih' }, store)[0].bindPort,
    19000
  );
  assert.deepEqual(request.writes, [{
    statusCode: 502,
    body: {
      ok: false,
      error: 'frp_visitor_identity_verification_failed',
      message: 'FRP Visitor 身份校验失败，已恢复原配置。'
    }
  }]);
  assert.equal(JSON.stringify(request.writes).includes('stcp-private-secret'), false);
  assert.equal(JSON.stringify(request.writes).includes('127.0.0.1:19527'), false);
});

test('FRP visitor update identity failure preserves previous config, desired state and registry', async () => {
  const fixture = createFrpFixture();
  const initial = await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'visitor',
    serverId: 'server-local-home',
    secretKey: 'previous-secret',
    bindPort: 19527
  }, {
    fs,
    runFrpc: async () => successfulProcessResult(),
    restartFrpc: async () => successfulProcessResult()
  });
  const manifestPath = path.join(fixture.aiHomeDir, 'frp', 'desired-routes.json');
  const previousFragment = fs.readFileSync(initial.fragmentPath, 'utf8');
  const previousManifest = fs.readFileSync(manifestPath, 'utf8');
  const store = createStoreDeps();
  const previousRegistry = upsertManagedFrpRoute({
    stableServerId: 'server-local-home',
    name: 'Local Home',
    bindPort: 19527,
    health: 'healthy'
  }, { fs: {}, aiHomeDir: fixture.aiHomeDir }, store);
  let reloadCalls = 0;
  let removeCalls = 0;
  const request = createContext('POST', '/v0/webui/server-routes/frp/apply', {
    role: 'visitor',
    stableServerId: 'server-local-home',
    name: 'Local Home',
    bindPort: 19528,
    secretKey: 'next-secret'
  }, {
    ...store,
    aiHomeDir: fixture.aiHomeDir,
    frpVisitorVerifyMaxAttempts: 1,
    applyAihFrpConfig: (options) => applyAihFrpConfig({
      ...options,
      configPath: fixture.configPath
    }, {
      fs,
      runFrpc: async (args) => {
        if (args[0] === 'reload') reloadCalls += 1;
        return successfulProcessResult();
      },
      restartFrpc: async () => successfulProcessResult()
    }),
    verifyFrpVisitorIdentity: async () => {
      const error = new Error('new visitor identity is unavailable');
      error.code = 'fabric_frp_server_identity_unavailable';
      throw error;
    },
    removeAihFrpConfig: async () => {
      removeCalls += 1;
      throw new Error('remove compensation must not run');
    }
  });

  assert.equal(await handleWebUiFrpConfigRoutes(request.context), true);
  assert.equal(fs.readFileSync(initial.fragmentPath, 'utf8'), previousFragment);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), previousManifest);
  assert.deepEqual(
    listManagedFrpRoutes({ fs: {}, aiHomeDir: fixture.aiHomeDir }, store),
    [previousRegistry]
  );
  assert.equal(reloadCalls, 2);
  assert.equal(removeCalls, 0);
  assert.equal(request.writes[0].statusCode, 502);
  assert.equal(request.writes[0].body.error, 'frp_visitor_identity_verification_failed');
  assert.equal(JSON.stringify(request.writes).includes('previous-secret'), false);
  assert.equal(JSON.stringify(request.writes).includes('next-secret'), false);
});

test('FRP visitor registry failure restores previous config and previous registry', async () => {
  const fixture = createFrpFixture();
  const initial = await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'visitor',
    serverId: 'server-local-home',
    secretKey: 'previous-secret',
    bindPort: 19527
  }, {
    fs,
    runFrpc: async () => successfulProcessResult(),
    restartFrpc: async () => successfulProcessResult()
  });
  const manifestPath = path.join(fixture.aiHomeDir, 'frp', 'desired-routes.json');
  const previousFragment = fs.readFileSync(initial.fragmentPath, 'utf8');
  const previousManifest = fs.readFileSync(manifestPath, 'utf8');
  const previousRegistry = {
    stableServerId: 'server-local-home',
    name: 'Local Home',
    bindPort: 19527,
    endpoint: 'http://127.0.0.1:19527',
    health: 'healthy',
    updatedAt: 100
  };
  let currentRegistry = previousRegistry;
  let reloadCalls = 0;
  let newSaveAttempts = 0;
  let restoreAttempts = 0;
  const request = createContext('POST', '/v0/webui/server-routes/frp/apply', {
    role: 'visitor',
    stableServerId: 'server-local-home',
    name: 'Local Home',
    bindPort: 19528,
    secretKey: 'next-secret'
  }, {
    aiHomeDir: fixture.aiHomeDir,
    frpVisitorVerifyMaxAttempts: 1,
    applyAihFrpConfig: (options) => applyAihFrpConfig({
      ...options,
      configPath: fixture.configPath
    }, {
      fs,
      runFrpc: async (args) => {
        if (args[0] === 'reload') reloadCalls += 1;
        return successfulProcessResult();
      },
      restartFrpc: async () => successfulProcessResult()
    }),
    verifyFrpVisitorIdentity: async (visitor) => ({
      ok: true,
      stableServerId: visitor.stableServerId
    }),
    listFrpVisitorRoutes: () => [currentRegistry],
    saveFrpVisitorRoute: (route) => {
      currentRegistry = route;
      if (route.bindPort === 19528) {
        newSaveAttempts += 1;
        const error = new Error('registry write failed after mutation');
        error.code = 'frp_route_registry_write_failed';
        throw error;
      }
      restoreAttempts += 1;
      return route;
    },
    removeFrpVisitorRoute: () => {
      currentRegistry = null;
      return true;
    }
  });

  assert.equal(await handleWebUiFrpConfigRoutes(request.context), true);
  assert.equal(fs.readFileSync(initial.fragmentPath, 'utf8'), previousFragment);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), previousManifest);
  assert.deepEqual(currentRegistry, previousRegistry);
  assert.equal(reloadCalls, 2);
  assert.equal(newSaveAttempts, 1);
  assert.equal(restoreAttempts, 1);
  assert.equal(request.writes[0].statusCode, 502);
  assert.equal(request.writes[0].body.error, 'frp_visitor_identity_verification_failed');
});

test('FRP serializes same-visitor apply through identity verification and cleanup', async () => {
  const events = [];
  let releaseFirstVerification;
  const firstVerification = new Promise((resolve) => {
    releaseFirstVerification = resolve;
  });
  const first = createContext('POST', '/v0/webui/server-routes/frp/apply', {
    role: 'visitor',
    stableServerId: 'server-local-home',
    bindPort: 19527,
    secretKey: 'first-secret'
  }, {
    frpVisitorVerifyMaxAttempts: 1,
    applyAihFrpConfig: async (options) => {
      events.push('apply-first');
      return completeFakeApply(options, {
        ok: true,
        action: 'reload',
        changes: { fragment: true }
      });
    },
    verifyFrpVisitorIdentity: async () => {
      events.push('verify-first');
      await firstVerification;
      const error = new Error('first identity failed');
      error.code = 'fabric_frp_server_identity_unavailable';
      throw error;
    },
    removeFrpVisitorRoute: () => true
  });
  const second = createContext('POST', '/v0/webui/server-routes/frp/apply', {
    role: 'visitor',
    stableServerId: 'server-local-home',
    bindPort: 19528,
    secretKey: 'second-secret'
  }, {
    frpVisitorVerifyMaxAttempts: 1,
    applyAihFrpConfig: async (options) => {
      events.push('apply-second');
      return completeFakeApply(options, {
        ok: true,
        action: 'reload',
        changes: { fragment: true }
      });
    },
    verifyFrpVisitorIdentity: async (visitor) => {
      events.push('verify-second');
      return { ok: true, stableServerId: visitor.stableServerId };
    },
    saveFrpVisitorRoute: (route) => {
      events.push('save-second');
      return route;
    }
  });

  const firstPending = handleWebUiFrpConfigRoutes(first.context);
  await new Promise((resolve) => setImmediate(resolve));
  const secondPending = handleWebUiFrpConfigRoutes(second.context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ['apply-first', 'verify-first']);
  releaseFirstVerification();
  await Promise.all([firstPending, secondPending]);
  assert.deepEqual(events, [
    'apply-first',
    'verify-first',
    'apply-second',
    'verify-second',
    'save-second'
  ]);
  assert.equal(first.writes[0].statusCode, 502);
  assert.equal(second.writes[0].statusCode, 200);
});

test('FRP remove API deletes the managed config before removing visitor registry metadata', async () => {
  const store = createStoreDeps();
  const events = [];
  upsertManagedFrpRoute({
    stableServerId: 'server-local-home',
    name: 'Local Home',
    bindPort: 19527,
    health: 'healthy'
  }, { fs: {}, aiHomeDir: '/tmp/aih' }, store);
  const request = createContext('DELETE', '/v0/webui/server-routes/frp/remove', {
    role: 'visitor',
    stableServerId: 'server-local-home'
  }, {
    ...store,
    removeAihFrpConfig: async (options) => {
      events.push('remove-config');
      assert.deepEqual(options, {
        aiHomeDir: '/tmp/aih',
        role: 'visitor',
        serverId: 'server-local-home'
      });
      return { ok: true, removed: true, action: 'reload' };
    },
    removeFrpVisitorRoute: (serverId) => {
      events.push('remove-registry');
      return removeManagedFrpRoute(
        serverId,
        { fs: {}, aiHomeDir: '/tmp/aih' },
        store
      );
    }
  });

  assert.equal(await handleWebUiFrpConfigRoutes(request.context), true);
  assert.deepEqual(events, ['remove-config', 'remove-registry']);
  assert.deepEqual(
    listManagedFrpRoutes({ fs: {}, aiHomeDir: '/tmp/aih' }, store),
    []
  );
  assert.deepEqual(request.writes, [{
    statusCode: 200,
    body: {
      ok: true,
      removed: true,
      role: 'visitor',
      stableServerId: 'server-local-home',
      action: 'reload'
    }
  }]);
  assert.equal(request.headers['cache-control'], 'no-store');
});

test('FRP apply errors are mapped without leaking a secret from process stderr', async () => {
  const request = createContext('POST', '/v0/webui/server-routes/frp/apply', {
    role: 'visitor',
    stableServerId: 'server-local-home',
    bindPort: 19527,
    secretKey: 'stcp-private-secret'
  }, {
    applyAihFrpConfig: async () => {
      const error = new Error('reload failed: stcp-private-secret');
      error.code = 'frp_reload_failed';
      throw error;
    }
  });

  assert.equal(await handleWebUiFrpConfigRoutes(request.context), true);
  assert.deepEqual(request.writes, [{
    statusCode: 502,
    body: {
      ok: false,
      error: 'frp_reload_failed',
      message: 'FRP 配置未能生效，已尝试恢复原配置。'
    }
  }]);
  assert.equal(JSON.stringify(request.writes).includes('stcp-private-secret'), false);
});

test('FRP status reports automatic discovery without exposing the config path', async () => {
  const store = createStoreDeps();
  upsertManagedFrpRoute({
    stableServerId: 'server-local-home',
    name: 'Local Home',
    bindPort: 19527
  }, { fs: {}, aiHomeDir: '/tmp/aih' }, store);
  const request = createContext('GET', '/v0/webui/server-routes/frp', undefined, {
    ...store,
    discoverFrpcConfigPath: () => '/opt/homebrew/etc/frp/frpc.toml'
  });

  assert.equal(await handleWebUiFrpConfigRoutes(request.context), true);
  assert.equal(request.writes[0].statusCode, 200);
  assert.equal(request.writes[0].body.available, true);
  assert.equal(request.writes[0].body.configFileName, 'frpc.toml');
  assert.equal(request.writes[0].body.visitors.length, 1);
  assert.equal(JSON.stringify(request.writes).includes('/opt/homebrew'), false);
});
