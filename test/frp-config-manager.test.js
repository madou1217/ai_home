'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  AIH_FRP_NAME_PREFIX,
  applyAihFrpConfig,
  atomicWritePrivate,
  defaultRunProcess,
  discoverFrpcConfigPath,
  prepareFrpcMainConfig,
  reconcileAihFrpConfig,
  removeAihFrpConfig,
  renderAihFrpcFragment
} = require('../lib/cli/services/fabric/frp-config-manager');

function createFixture(mainContent = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-frp-config-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const configPath = path.join(root, 'etc', 'frp', 'frpc.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, mainContent, { mode: 0o644 });
  return { root, aiHomeDir, configPath };
}

function baseMainConfig() {
  return [
    'serverAddr = "frps.example.com"',
    'serverPort = 7000',
    '',
    '[[proxies]]',
    'name = "customer-owned-ssh"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    'localPort = 22',
    'remotePort = 6022',
    ''
  ].join('\n');
}

function successResult() {
  return { status: 0, stdout: '', stderr: '' };
}

test('defaultRunProcess bounds a stuck FRP command', () => {
  const startedAt = Date.now();
  const result = defaultRunProcess(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 10_000)'],
    { timeout: 50 }
  );

  assert.notEqual(result.status, 0);
  assert.equal(result.error && result.error.code, 'ETIMEDOUT');
  assert.ok(Date.now() - startedAt < 2_000);
});

test('atomicWritePrivate preserves the destination when atomic replacement is unavailable', () => {
  const fixture = createFixture('original-content\n');
  const fsImpl = Object.create(fs);
  const removed = [];
  fsImpl.renameSync = (sourcePath, destinationPath) => {
    if (fs.existsSync(destinationPath)) {
      const error = new Error('destination is locked');
      error.code = 'EPERM';
      throw error;
    }
    return fs.renameSync(sourcePath, destinationPath);
  };
  fsImpl.unlinkSync = (filePath) => {
    removed.push(filePath);
    return fs.unlinkSync(filePath);
  };

  assert.throws(
    () => atomicWritePrivate(
      fsImpl,
      path,
      fixture.configPath,
      'replacement-content\n',
      { createNonce: () => 'atomic-failure' }
    ),
    (error) => error && error.code === 'EPERM'
  );

  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), 'original-content\n');
  assert.equal(removed.includes(fixture.configPath), false);
  assert.equal(fs.existsSync(`${fixture.configPath}.aih-tmp-atomic-failure`), false);
});

test('discoverFrpcConfigPath honors explicit and environment paths before platform defaults', () => {
  const fixture = createFixture(baseMainConfig());
  const envConfigPath = path.join(fixture.root, 'env-frpc.toml');
  fs.writeFileSync(envConfigPath, 'serverAddr = "env.example.com"\n');

  assert.equal(
    discoverFrpcConfigPath({ configPath: fixture.configPath }, { fs }),
    fixture.configPath
  );
  assert.equal(
    discoverFrpcConfigPath({}, {
      fs,
      env: { AIH_FRPC_CONFIG: envConfigPath },
      platform: 'darwin',
      homedir: () => fixture.root,
      defaultCandidates: [fixture.configPath]
    }),
    envConfigPath
  );
  assert.throws(
    () => discoverFrpcConfigPath({}, {
      fs,
      env: {},
      platform: 'linux',
      homedir: () => fixture.root,
      defaultCandidates: [path.join(fixture.root, 'missing.toml')]
    }),
    (error) => error && error.code === 'frpc_config_not_found'
  );
});

test('prepareFrpcMainConfig adds one managed include and one loopback webServer without touching user proxies', () => {
  const original = baseMainConfig();
  const includePattern = '/home/alice/.ai_home/frp/frpc.d/*.toml';

  const first = prepareFrpcMainConfig(original, { includePattern, webServerPort: 7400 });
  const second = prepareFrpcMainConfig(first.content, { includePattern, webServerPort: 7400 });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.content, first.content);
  assert.equal((first.content.match(/includes\s*=/g) || []).length, 1);
  assert.equal((first.content.match(/\[webServer\]/g) || []).length, 1);
  assert.match(first.content, /addr = "127\.0\.0\.1"/);
  assert.match(first.content, /port = 7400/);
  assert.ok(first.content.includes(original.trim()));
});

test('prepareFrpcMainConfig extends existing includes and preserves an existing loopback webServer', () => {
  const includePattern = '/home/alice/.ai_home/frp/frpc.d/*.toml';
  const original = [
    'includes = ["/home/alice/frp.d/*.toml"]',
    'serverAddr = "frps.example.com"',
    '',
    '[webServer]',
    'addr = "localhost"',
    'port = 7500',
    'user = "operator"',
    '',
    '[[proxies]]',
    'name = "customer-owned"',
    'type = "tcp"',
    ''
  ].join('\n');

  const result = prepareFrpcMainConfig(original, { includePattern, webServerPort: 7400 });

  assert.match(result.content, /includes = \["\/home\/alice\/frp\.d\/\*\.toml", "\/home\/alice\/\.ai_home\/frp\/frpc\.d\/\*\.toml"\]/);
  assert.match(result.content, /addr = "localhost"/);
  assert.match(result.content, /port = 7500/);
  assert.match(result.content, /user = "operator"/);
  assert.equal((result.content.match(/\[webServer\]/g) || []).length, 1);
});

test('prepareFrpcMainConfig ignores quoted text inside multiline includes comments', () => {
  const result = prepareFrpcMainConfig([
    'includes = [',
    '  "/home/alice/frp.d/*.toml", # "comment-is-not-an-include"',
    ']',
    'serverAddr = "frps.example.com"',
    ''
  ].join('\n'), {
    includePattern: '/home/alice/.ai_home/frp/frpc.d/*.toml'
  });

  assert.match(result.content, /\/home\/alice\/frp\.d\/\*\.toml/);
  assert.match(result.content, /\/home\/alice\/\.ai_home\/frp\/frpc\.d\/\*\.toml/);
  assert.doesNotMatch(result.content, /comment-is-not-an-include/);
});

test('prepareFrpcMainConfig refuses a non-loopback management listener', () => {
  assert.throws(
    () => prepareFrpcMainConfig([
      'serverAddr = "frps.example.com"',
      '',
      '[webServer]',
      'addr = "0.0.0.0"',
      'port = 7400',
      ''
    ].join('\n'), {
      includePattern: '/tmp/aih/*.toml'
    }),
    (error) => error && error.code === 'frpc_web_server_not_loopback'
  );
});

test('renderAihFrpcFragment creates owned STCP provider and visitor fragments', () => {
  const provider = renderAihFrpcFragment({
    role: 'provider',
    serverId: 'local-home',
    secretKey: 'tunnel-secret',
    localPort: 9527
  });
  const visitor = renderAihFrpcFragment({
    role: 'visitor',
    serverId: 'local-home',
    secretKey: 'tunnel-secret',
    bindPort: 19527
  });

  assert.equal(AIH_FRP_NAME_PREFIX, 'aih-');
  assert.match(provider, /\[\[proxies\]\]/);
  assert.match(provider, /name = "aih-local-local-home"/);
  assert.match(provider, /type = "stcp"/);
  assert.match(provider, /localIP = "127\.0\.0\.1"/);
  assert.match(provider, /localPort = 9527/);
  assert.match(visitor, /\[\[visitors\]\]/);
  assert.match(visitor, /name = "aih-local-local-home-visitor"/);
  assert.match(visitor, /serverName = "aih-local-local-home"/);
  assert.match(visitor, /bindAddr = "127\.0\.0\.1"/);
  assert.match(visitor, /bindPort = 19527/);
  assert.throws(
    () => renderAihFrpcFragment({
      role: 'provider',
      serverId: 'local-home',
      proxyName: 'customer-owned',
      secretKey: 'tunnel-secret'
    }),
    (error) => error && error.code === 'frp_proxy_not_aih_owned'
  );
  for (const serverId of ['Server-home', ' local-home', `a${'b'.repeat(64)}`]) {
    assert.throws(
      () => renderAihFrpcFragment({
        role: 'provider',
        serverId,
        secretKey: 'tunnel-secret'
      }),
      (error) => error && error.code === 'frp_server_id_invalid',
      serverId
    );
  }
});

test('applyAihFrpConfig verifies then restarts on first setup and reloads later fragment updates', async () => {
  const fixture = createFixture(baseMainConfig());
  const calls = [];
  const deps = {
    fs,
    runFrpc: async (args, context) => {
      assert.equal(JSON.stringify(context).includes('tunnel-secret'), false);
      calls.push(['frpc', ...args]);
      return successResult();
    },
    restartFrpc: async (context) => {
      assert.equal(JSON.stringify(context).includes('tunnel-secret'), false);
      calls.push(['restart', context.configPath]);
      return successResult();
    }
  };

  const first = await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'provider',
    serverId: 'local-home',
    secretKey: 'tunnel-secret',
    localPort: 9527
  }, deps);

  assert.equal(first.ok, true);
  assert.equal(first.action, 'restart');
  assert.equal(first.changes.permissions, true);
  assert.deepEqual(calls, [
    ['frpc', 'verify', '-c', fixture.configPath],
    ['restart', fixture.configPath]
  ]);
  assert.equal(fs.statSync(fixture.configPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(first.fragmentPath).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(fixture.configPath, 'utf8'), /customer-owned-ssh/);
  assert.match(fs.readFileSync(first.fragmentPath, 'utf8'), /localPort = 9527/);
  assert.equal(JSON.stringify(first).includes('tunnel-secret'), false);

  calls.length = 0;
  const second = await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'provider',
    serverId: 'local-home',
    secretKey: 'tunnel-secret',
    localPort: 9528
  }, deps);

  assert.equal(second.action, 'reload');
  assert.equal(second.changes.permissions, false);
  assert.deepEqual(calls, [
    ['frpc', 'verify', '-c', fixture.configPath],
    ['frpc', 'reload', '-c', fixture.configPath]
  ]);
  assert.match(fs.readFileSync(second.fragmentPath, 'utf8'), /localPort = 9528/);
});

test('applyAihFrpConfig persists the effective desired route in a private manifest', async () => {
  const fixture = createFixture(baseMainConfig());

  const result = await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'visitor',
    serverId: 'server-local-home',
    secretKey: 'tunnel-secret',
    bindPort: 19527
  }, {
    fs,
    runFrpc: async () => successResult(),
    restartFrpc: async () => successResult()
  });

  const manifestPath = path.join(fixture.aiHomeDir, 'frp', 'desired-routes.json');
  assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), {
    version: 1,
    routes: [{
      role: 'visitor',
      serverId: 'server-local-home',
      proxyName: 'aih-local-server-local-home',
      visitorName: 'aih-local-server-local-home-visitor',
      secretKey: 'tunnel-secret',
      configPath: fixture.configPath,
      webServerPort: 7400,
      bindAddr: '127.0.0.1',
      bindPort: 19527
    }]
  });
  assert.equal(JSON.stringify(result).includes('tunnel-secret'), false);
});

test('applyAihFrpConfig rejects a second configPath within one AIH_HOME', async () => {
  const fixture = createFixture(baseMainConfig());
  await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'provider',
    serverId: 'server-local-home',
    secretKey: 'first-secret',
    localPort: 9527
  }, {
    fs,
    runFrpc: async () => successResult(),
    restartFrpc: async () => successResult()
  });
  const secondConfigPath = path.join(fixture.root, 'second', 'frpc.toml');
  fs.mkdirSync(path.dirname(secondConfigPath), { recursive: true });
  fs.writeFileSync(secondConfigPath, baseMainConfig());
  const secondOriginal = fs.readFileSync(secondConfigPath, 'utf8');
  const manifestPath = path.join(fixture.aiHomeDir, 'frp', 'desired-routes.json');
  const manifestOriginal = fs.readFileSync(manifestPath, 'utf8');

  await assert.rejects(
    applyAihFrpConfig({
      configPath: secondConfigPath,
      aiHomeDir: fixture.aiHomeDir,
      role: 'visitor',
      serverId: 'server-other-home',
      secretKey: 'second-secret',
      bindPort: 19528
    }, {
      fs,
      runFrpc: async () => successResult(),
      restartFrpc: async () => successResult()
    }),
    (error) => error && error.code === 'frp_multiple_instances_unsupported'
  );

  assert.equal(fs.readFileSync(secondConfigPath, 'utf8'), secondOriginal);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestOriginal);
  assert.equal(fs.existsSync(path.join(
    fixture.aiHomeDir,
    'frp',
    'frpc.d',
    'aih-server-other-home-visitor.toml'
  )), false);
});

test('reconcileAihFrpConfig reports multiple stored config paths as unsupported', async () => {
  const fixture = createFixture(baseMainConfig());
  await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'provider',
    serverId: 'server-local-home',
    secretKey: 'first-secret',
    localPort: 9527
  }, {
    fs,
    runFrpc: async () => successResult(),
    restartFrpc: async () => successResult()
  });
  const manifestPath = path.join(fixture.aiHomeDir, 'frp', 'desired-routes.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.routes.push({
    ...manifest.routes[0],
    serverId: 'server-other-home',
    proxyName: 'aih-local-server-other-home',
    configPath: path.join(fixture.root, 'other', 'frpc.toml')
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  await assert.rejects(
    reconcileAihFrpConfig({ aiHomeDir: fixture.aiHomeDir }, { fs }),
    (error) => error && error.code === 'frp_multiple_instances_unsupported'
  );
});

test('reconcileAihFrpConfig repairs managed config content and permission drift from desired state', async () => {
  const fixture = createFixture(baseMainConfig());
  const deps = {
    fs,
    runFrpc: async () => successResult(),
    restartFrpc: async () => successResult()
  };
  const applied = await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'provider',
    serverId: 'server-local-home',
    secretKey: 'tunnel-secret',
    localPort: 9527
  }, deps);
  const manifestPath = path.join(fixture.aiHomeDir, 'frp', 'desired-routes.json');

  fs.writeFileSync(fixture.configPath, baseMainConfig(), { mode: 0o644 });
  fs.writeFileSync(applied.fragmentPath, '# drifted managed fragment\n', { mode: 0o644 });
  fs.chmodSync(manifestPath, 0o644);
  const calls = [];

  const result = await reconcileAihFrpConfig({ aiHomeDir: fixture.aiHomeDir }, {
    fs,
    runFrpc: async (args) => {
      calls.push(['frpc', ...args]);
      return successResult();
    },
    restartFrpc: async () => {
      calls.push(['restart']);
      return successResult();
    }
  });

  assert.deepEqual(result, {
    ok: true,
    total: 1,
    reconciled: 1,
    unchanged: 0,
    failures: []
  });
  assert.match(fs.readFileSync(fixture.configPath, 'utf8'), /customer-owned-ssh/);
  assert.match(fs.readFileSync(fixture.configPath, 'utf8'), /includes = /);
  assert.match(fs.readFileSync(applied.fragmentPath, 'utf8'), /localPort = 9527/);
  assert.equal(fs.statSync(fixture.configPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(applied.fragmentPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
  assert.deepEqual(calls, [
    ['frpc', 'verify', '-c', fixture.configPath],
    ['restart']
  ]);
  assert.equal(JSON.stringify(result).includes('tunnel-secret'), false);
});

test('reconcileAihFrpConfig verifies and reloads unchanged desired routes after startup', async () => {
  const fixture = createFixture(baseMainConfig());
  await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'visitor',
    serverId: 'server-local-home',
    secretKey: 'tunnel-secret',
    bindPort: 19527
  }, {
    fs,
    runFrpc: async () => successResult(),
    restartFrpc: async () => successResult()
  });
  const calls = [];

  const result = await reconcileAihFrpConfig({ aiHomeDir: fixture.aiHomeDir }, {
    fs,
    runFrpc: async (args) => {
      calls.push(args.slice());
      return successResult();
    }
  });

  assert.deepEqual(result, {
    ok: true,
    total: 1,
    reconciled: 1,
    unchanged: 0,
    failures: []
  });
  assert.deepEqual(calls, [
    ['verify', '-c', fixture.configPath],
    ['reload', '-c', fixture.configPath]
  ]);
});

test('reconcileAihFrpConfig force reloads only once when multiple routes are unchanged', async () => {
  const fixture = createFixture(baseMainConfig());
  const applyDeps = {
    fs,
    runFrpc: async () => successResult(),
    restartFrpc: async () => successResult()
  };
  await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'provider',
    serverId: 'server-local-home',
    secretKey: 'provider-secret',
    localPort: 9527
  }, applyDeps);
  await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'visitor',
    serverId: 'server-other-home',
    secretKey: 'visitor-secret',
    bindPort: 19528
  }, applyDeps);
  const calls = [];

  const result = await reconcileAihFrpConfig({ aiHomeDir: fixture.aiHomeDir }, {
    fs,
    runFrpc: async (args) => {
      calls.push(args.slice());
      return successResult();
    }
  });

  assert.deepEqual(result, {
    ok: true,
    total: 2,
    reconciled: 1,
    unchanged: 1,
    failures: []
  });
  assert.deepEqual(calls, [
    ['verify', '-c', fixture.configPath],
    ['reload', '-c', fixture.configPath]
  ]);
});

test('reconcileAihFrpConfig does not resurrect a route removed after startup state was read', async () => {
  const fixture = createFixture(baseMainConfig());
  const applied = await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'visitor',
    serverId: 'server-local-home',
    secretKey: 'tunnel-secret',
    bindPort: 19527
  }, {
    fs,
    runFrpc: async () => successResult(),
    restartFrpc: async () => successResult()
  });
  const manifestPath = path.join(fixture.aiHomeDir, 'frp', 'desired-routes.json');
  fs.chmodSync(manifestPath, 0o644);
  const fsImpl = Object.create(fs);
  let removedDuringReconcile = false;
  fsImpl.unlinkSync = (filePath) => {
    const result = fs.unlinkSync(filePath);
    if (!removedDuringReconcile && filePath.endsWith('.aih-frpc-config.lock')) {
      removedDuringReconcile = true;
      fs.writeFileSync(
        manifestPath,
        `${JSON.stringify({ version: 1, routes: [] }, null, 2)}\n`,
        { mode: 0o600 }
      );
      fs.unlinkSync(applied.fragmentPath);
    }
    return result;
  };
  let processCalls = 0;

  const result = await reconcileAihFrpConfig({ aiHomeDir: fixture.aiHomeDir }, {
    fs: fsImpl,
    runFrpc: async () => { processCalls += 1; return successResult(); },
    restartFrpc: async () => { processCalls += 1; return successResult(); }
  });

  assert.equal(removedDuringReconcile, true);
  assert.deepEqual(result, {
    ok: true,
    total: 1,
    reconciled: 0,
    unchanged: 1,
    failures: []
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), {
    version: 1,
    routes: []
  });
  assert.equal(fs.existsSync(applied.fragmentPath), false);
  assert.equal(processCalls, 0);
});

test('removeAihFrpConfig deletes only the selected managed fragment then verifies and reloads', async () => {
  const fixture = createFixture(baseMainConfig());
  const deps = {
    fs,
    runFrpc: async () => successResult(),
    restartFrpc: async () => successResult()
  };
  const applied = await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'visitor',
    serverId: 'server-local-home',
    secretKey: 'tunnel-secret',
    bindPort: 19527
  }, deps);
  const customerFragment = path.join(path.dirname(applied.fragmentPath), 'customer-owned.toml');
  fs.writeFileSync(customerFragment, '# customer owned\n');
  const calls = [];

  const result = await removeAihFrpConfig({
    aiHomeDir: fixture.aiHomeDir,
    role: 'visitor',
    serverId: 'server-local-home'
  }, {
    fs,
    runFrpc: async (args) => {
      calls.push(args.slice());
      return successResult();
    }
  });

  assert.deepEqual(result, {
    ok: true,
    removed: true,
    role: 'visitor',
    serverId: 'server-local-home',
    action: 'reload'
  });
  assert.equal(fs.existsSync(applied.fragmentPath), false);
  assert.equal(fs.readFileSync(customerFragment, 'utf8'), '# customer owned\n');
  assert.match(fs.readFileSync(fixture.configPath, 'utf8'), /customer-owned-ssh/);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(fixture.aiHomeDir, 'frp', 'desired-routes.json'),
    'utf8'
  ));
  assert.deepEqual(manifest, { version: 1, routes: [] });
  assert.deepEqual(calls, [
    ['verify', '-c', fixture.configPath],
    ['reload', '-c', fixture.configPath]
  ]);
});

test('removeAihFrpConfig restores desired state and fragment when reload fails', async () => {
  const fixture = createFixture(baseMainConfig());
  const applied = await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'visitor',
    serverId: 'server-local-home',
    secretKey: 'tunnel-secret',
    bindPort: 19527
  }, {
    fs,
    runFrpc: async () => successResult(),
    restartFrpc: async () => successResult()
  });
  const manifestPath = path.join(fixture.aiHomeDir, 'frp', 'desired-routes.json');
  const previousFragment = fs.readFileSync(applied.fragmentPath, 'utf8');
  const previousManifest = fs.readFileSync(manifestPath, 'utf8');
  let reloadAttempts = 0;

  await assert.rejects(
    removeAihFrpConfig({
      aiHomeDir: fixture.aiHomeDir,
      role: 'visitor',
      serverId: 'server-local-home'
    }, {
      fs,
      runFrpc: async (args) => {
        if (args[0] !== 'reload') return successResult();
        reloadAttempts += 1;
        return reloadAttempts === 1
          ? { status: 1, stdout: '', stderr: 'reload failed' }
          : successResult();
      }
    }),
    (error) => error && error.code === 'frp_reload_failed'
      && error.rollback && error.rollback.ok === true
  );

  assert.equal(fs.readFileSync(applied.fragmentPath, 'utf8'), previousFragment);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), previousManifest);
  assert.equal(reloadAttempts, 2);
});

test('installed frpc verifies the generated provider config without touching the real service', async (t) => {
  const probe = spawnSync('frpc', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('frpc is not installed on this host');
    return;
  }
  const fixture = createFixture(baseMainConfig());
  const calls = [];

  const result = await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'provider',
    serverId: 'real-verify-fixture',
    secretKey: 'fixture-secret-not-used-outside-the-temp-directory',
    localPort: 9527
  }, {
    fs,
    runFrpc: (args) => {
      calls.push(args);
      return spawnSync('frpc', args, { encoding: 'utf8' });
    },
    restartFrpc: async () => successResult()
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'restart');
  assert.deepEqual(calls, [['verify', '-c', fixture.configPath]]);
  assert.match(fs.readFileSync(result.fragmentPath, 'utf8'), /type = "stcp"/);
});

test('applyAihFrpConfig dry-run reports a redacted plan without writes or process calls', async () => {
  const fixture = createFixture(baseMainConfig());
  const original = fs.readFileSync(fixture.configPath, 'utf8');
  let calls = 0;

  const result = await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'visitor',
    serverId: 'local-home',
    secretKey: 'tunnel-secret',
    bindPort: 19527,
    dryRun: true
  }, {
    fs,
    runFrpc: async () => { calls += 1; return successResult(); },
    restartFrpc: async () => { calls += 1; return successResult(); }
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.action, 'restart');
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), original);
  assert.equal(fs.existsSync(result.fragmentPath), false);
  assert.equal(JSON.stringify(result).includes('tunnel-secret'), false);
});

test('applyAihFrpConfig refuses to run while another AIH FRP update owns the lock', async () => {
  const fixture = createFixture(baseMainConfig());
  const lockPath = path.join(fixture.aiHomeDir, 'frp', '.aih-frpc-config.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, 'another update\n', { mode: 0o600 });
  const original = fs.readFileSync(fixture.configPath, 'utf8');

  await assert.rejects(
    applyAihFrpConfig({
      configPath: fixture.configPath,
      aiHomeDir: fixture.aiHomeDir,
      role: 'provider',
      serverId: 'local-home',
      secretKey: 'tunnel-secret'
    }, {
      fs,
      runFrpc: async () => successResult(),
      restartFrpc: async () => successResult()
    }),
    (error) => error && error.code === 'frp_config_locked' && error.lockPath === lockPath
  );

  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), original);
});

test('applyAihFrpConfig recovers an AIH lock whose owner process no longer exists', async () => {
  const fixture = createFixture(baseMainConfig());
  const lockPath = path.join(fixture.aiHomeDir, 'frp', '.aih-frpc-config.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: 424242, createdAt: 1 })}\n`, { mode: 0o600 });

  const result = await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'provider',
    serverId: 'local-home',
    secretKey: 'tunnel-secret'
  }, {
    fs,
    isProcessAlive: (pid) => {
      assert.equal(pid, 424242);
      return false;
    },
    runFrpc: async () => successResult(),
    restartFrpc: async () => successResult()
  });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('applyAihFrpConfig recovers an old corrupt lock without stealing a recent one', async () => {
  const fixture = createFixture(baseMainConfig());
  const lockPath = path.join(fixture.aiHomeDir, 'frp', '.aih-frpc-config.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, '', { mode: 0o600 });
  const now = Date.now();

  const result = await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'provider',
    serverId: 'local-home',
    secretKey: 'tunnel-secret'
  }, {
    fs,
    nowMs: () => now + 10 * 60 * 1000,
    staleLockMs: 5 * 60 * 1000,
    runFrpc: async () => successResult(),
    restartFrpc: async () => successResult()
  });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('applyAihFrpConfig re-merges a user main-config edit made before commit', async () => {
  const fixture = createFixture(baseMainConfig());
  let hookCalls = 0;

  await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'provider',
    serverId: 'local-home',
    secretKey: 'tunnel-secret'
  }, {
    fs,
    beforeCommit: () => {
      hookCalls += 1;
      fs.appendFileSync(fixture.configPath, '# user edit before commit\n');
    },
    runFrpc: async () => successResult(),
    restartFrpc: async () => successResult()
  });

  const finalMain = fs.readFileSync(fixture.configPath, 'utf8');
  assert.equal(hookCalls, 1);
  assert.match(finalMain, /# user edit before commit/);
  assert.match(finalMain, /includes = /);
  assert.match(finalMain, /customer-owned-ssh/);
});

test('applyAihFrpConfig rolls files back when verify fails', async () => {
  const fixture = createFixture(baseMainConfig());
  const original = fs.readFileSync(fixture.configPath, 'utf8');
  let restarted = false;

  await assert.rejects(
    applyAihFrpConfig({
      configPath: fixture.configPath,
      aiHomeDir: fixture.aiHomeDir,
      role: 'provider',
      serverId: 'local-home',
      secretKey: 'tunnel-secret'
    }, {
      fs,
      runFrpc: async () => ({ status: 1, stdout: '', stderr: 'invalid config' }),
      restartFrpc: async () => { restarted = true; return successResult(); }
    }),
    (error) => error && error.code === 'frp_verify_failed' && error.rollback && error.rollback.ok === true
  );

  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(fixture.aiHomeDir, 'frp', 'frpc.d', 'aih-local-home-provider.toml')), false);
  assert.equal(fs.existsSync(path.join(fixture.aiHomeDir, 'frp', 'desired-routes.json')), false);
  assert.equal(restarted, false);
});

test('applyAihFrpConfig restores the previous fragment when reload fails', async () => {
  const fixture = createFixture(baseMainConfig());
  const calls = [];
  const deps = {
    fs,
    runFrpc: async (args) => {
      calls.push(args.slice());
      return successResult();
    },
    restartFrpc: async () => successResult()
  };
  const first = await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'provider',
    serverId: 'local-home',
    secretKey: 'tunnel-secret',
    localPort: 9527
  }, deps);
  const previousFragment = fs.readFileSync(first.fragmentPath, 'utf8');
  const manifestPath = path.join(fixture.aiHomeDir, 'frp', 'desired-routes.json');
  const previousManifest = fs.readFileSync(manifestPath, 'utf8');

  let reloadAttempts = 0;
  await assert.rejects(
    applyAihFrpConfig({
      configPath: fixture.configPath,
      aiHomeDir: fixture.aiHomeDir,
      role: 'provider',
      serverId: 'local-home',
      secretKey: 'tunnel-secret',
      localPort: 9528
    }, {
      fs,
      runFrpc: async (args) => {
        if (args[0] === 'reload') {
          reloadAttempts += 1;
          return reloadAttempts === 1
            ? { status: 1, stdout: '', stderr: 'reload failed' }
            : successResult();
        }
        return successResult();
      },
      restartFrpc: async () => successResult()
    }),
    (error) => error && error.code === 'frp_reload_failed' && error.rollback && error.rollback.ok === true
  );

  assert.equal(fs.readFileSync(first.fragmentPath, 'utf8'), previousFragment);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), previousManifest);
  assert.equal(reloadAttempts, 2);
});

test('applyAihFrpConfig redacts both previous and next secrets from rollback recovery errors', async () => {
  const fixture = createFixture(baseMainConfig());
  const deps = {
    fs,
    runFrpc: async () => successResult(),
    restartFrpc: async () => successResult()
  };
  await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'visitor',
    serverId: 'server-local-home',
    secretKey: 'previous-tunnel-secret',
    bindPort: 19527
  }, deps);
  let reloadAttempts = 0;
  let capturedError = null;

  await assert.rejects(
    applyAihFrpConfig({
      configPath: fixture.configPath,
      aiHomeDir: fixture.aiHomeDir,
      role: 'visitor',
      serverId: 'server-local-home',
      secretKey: 'next-tunnel-secret',
      bindPort: 19528
    }, {
      fs,
      runFrpc: async (args) => {
        if (args[0] !== 'reload') return successResult();
        reloadAttempts += 1;
        return reloadAttempts === 1
          ? { status: 1, stdout: '', stderr: 'next-tunnel-secret failed' }
          : { status: 1, stdout: '', stderr: 'previous-tunnel-secret recovery failed' };
      }
    }),
    (error) => {
      capturedError = error;
      return error && error.code === 'frp_reload_failed';
    }
  );

  const serialized = JSON.stringify(capturedError);
  assert.equal(serialized.includes('previous-tunnel-secret'), false);
  assert.equal(serialized.includes('next-tunnel-secret'), false);
  assert.equal(reloadAttempts, 2);
});

test('applyAihFrpConfig restores the previous Visitor when activation validation fails', async () => {
  const fixture = createFixture(baseMainConfig());
  const initial = await applyAihFrpConfig({
    configPath: fixture.configPath,
    aiHomeDir: fixture.aiHomeDir,
    role: 'visitor',
    serverId: 'server-local-home',
    secretKey: 'previous-tunnel-secret',
    bindPort: 19527
  }, {
    fs,
    runFrpc: async () => successResult(),
    restartFrpc: async () => successResult()
  });
  const manifestPath = path.join(fixture.aiHomeDir, 'frp', 'desired-routes.json');
  const previousMain = fs.readFileSync(fixture.configPath, 'utf8');
  const previousFragment = fs.readFileSync(initial.fragmentPath, 'utf8');
  const previousManifest = fs.readFileSync(manifestPath, 'utf8');
  const calls = [];

  await assert.rejects(
    applyAihFrpConfig({
      configPath: fixture.configPath,
      aiHomeDir: fixture.aiHomeDir,
      role: 'visitor',
      serverId: 'server-local-home',
      secretKey: 'next-tunnel-secret',
      bindPort: 19528,
      validateActivation: async (activation) => {
        calls.push(['validate', activation]);
        const error = new Error('visitor identity mismatch');
        error.code = 'fabric_frp_server_identity_mismatch';
        throw error;
      }
    }, {
      fs,
      runFrpc: async (args) => {
        calls.push(['frpc', ...args]);
        return successResult();
      }
    }),
    (error) => error && error.code === 'frp_activation_validation_failed'
      && error.rollback && error.rollback.ok === true
  );

  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), previousMain);
  assert.equal(fs.readFileSync(initial.fragmentPath, 'utf8'), previousFragment);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), previousManifest);
  assert.deepEqual(calls.map((call) => call[0] === 'validate' ? ['validate'] : call), [
    ['frpc', 'verify', '-c', fixture.configPath],
    ['frpc', 'reload', '-c', fixture.configPath],
    ['validate'],
    ['frpc', 'reload', '-c', fixture.configPath]
  ]);
  const activation = calls.find((call) => call[0] === 'validate')[1];
  assert.equal(activation.role, 'visitor');
  assert.equal(activation.serverId, 'server-local-home');
  assert.equal(activation.bindPort, 19528);
  assert.equal(JSON.stringify(activation).includes('next-tunnel-secret'), false);
});

test('applyAihFrpConfig restores first-time files when restart fails', async () => {
  const fixture = createFixture(baseMainConfig());
  const original = fs.readFileSync(fixture.configPath, 'utf8');
  let restartAttempts = 0;

  await assert.rejects(
    applyAihFrpConfig({
      configPath: fixture.configPath,
      aiHomeDir: fixture.aiHomeDir,
      role: 'visitor',
      serverId: 'local-home',
      secretKey: 'tunnel-secret',
      bindPort: 19527
    }, {
      fs,
      runFrpc: async () => successResult(),
      restartFrpc: async () => {
        restartAttempts += 1;
        return restartAttempts === 1
          ? { status: 1, stdout: '', stderr: 'restart failed' }
          : successResult();
      }
    }),
    (error) => error && error.code === 'frp_restart_failed' && error.rollback && error.rollback.ok === true
  );

  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(fixture.aiHomeDir, 'frp', 'frpc.d', 'aih-local-home-visitor.toml')), false);
  assert.equal(fs.existsSync(path.join(fixture.aiHomeDir, 'frp', 'desired-routes.json')), false);
  assert.equal(restartAttempts, 2);
});
