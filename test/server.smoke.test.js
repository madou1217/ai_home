const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((err) => {
        if (err) return reject(err);
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForHealth(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return true;
    } catch (e) {}
    await sleep(120);
  }
  return false;
}

function seedCodexTestAccount(homeDir) {
  const codexDir = path.join(homeDir, '.ai_home', 'profiles', 'codex', '1', '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({
    last_refresh: new Date().toISOString(),
    tokens: {
      access_token: 'test_access_token',
      id_token: 'test_id_token',
      refresh_token: 'rt_test_refresh_token',
      account_id: 'acct_test_1'
    }
  }, null, 2));
}

function seedFakeCodexDesktopBundle(homeDir) {
  const aiHomeDir = path.join(homeDir, '.ai_home');
  const bundlePath = path.join(homeDir, 'Applications', 'Codex.app');
  const resourcesDir = path.join(bundlePath, 'Contents', 'Resources');
  const targetBinaryPath = path.join(resourcesDir, 'codex');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\nexit 0\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);
  fs.writeFileSync(path.join(aiHomeDir, 'desktop-client-paths.json'), JSON.stringify({
    codex: {
      macos: {
        clientName: 'Codex',
        executablePath: path.join(bundlePath, 'Contents', 'MacOS', 'Codex'),
        bundlePath
      }
    }
  }, null, 2));
  return { aiHomeDir, targetBinaryPath };
}

async function startProxy(t, extraArgs = [], envOverrides = {}) {
  const port = await getFreePort();
  const cliPath = path.join(process.cwd(), 'bin', 'ai-home.js');
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-smoke-'));
  seedCodexTestAccount(testHome);
  const env = { ...process.env };
  Object.keys(env).forEach((key) => {
    if (/^AIH_SERVER_/i.test(key)) delete env[key];
  });
  const child = spawn(process.execPath, [
    cliPath,
    'server',
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--provider',
    'codex',
    ...extraArgs
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...env,
      AIH_HOME: testHome,
      AIH_HOST_HOME: testHome,
      HOME: testHome,
      AIH_SERVER_HOST: '127.0.0.1',
      AIH_SERVER_PROXY_URL: '',
      AIH_SERVER_NO_PROXY: '127.0.0.1,localhost',
      HTTPS_PROXY: '',
      https_proxy: '',
      HTTP_PROXY: '',
      http_proxy: '',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      ...envOverrides
    }
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
  child.stdout.on('data', () => {});

  t.after(() => {
    try { child.kill('SIGTERM'); } catch (e) {}
    try { child.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch (_error) {}
  });

  return { child, port, testHome, getStderr: () => stderr };
}

async function startMockUpstream(t) {
  const port = await getFreePort();
  const server = http.createServer(async (req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
    if (method === 'GET' && pathname === '/models') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        models: [{ slug: 'gpt-dynamic', supported_in_api: true, visibility: 'list' }]
      }));
      return;
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  t.after(() => {
    try { server.close(); } catch (_error) {}
  });
  return `http://127.0.0.1:${port}`;
}

async function startSlowModelsUpstream(t, delayMs) {
  const port = await getFreePort();
  const server = http.createServer(async (req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
    if (method === 'GET' && pathname === '/models') {
      await sleep(delayMs);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        models: [{ slug: 'gpt-delayed', supported_in_api: true, visibility: 'list' }]
      }));
      return;
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  t.after(() => {
    try { server.close(); } catch (_error) {}
  });
  return `http://127.0.0.1:${port}`;
}

test('server serve exposes health/models/metrics', async (t) => {
  const upstream = await startMockUpstream(t);
  const { port, getStderr } = await startProxy(t, ['--codex-base-url', upstream]);
  const ready = await waitForHealth(port, 12000);
  assert.equal(ready, true, `server did not become healthy: ${getStderr()}`);

  const readyRes = await fetch(`http://127.0.0.1:${port}/readyz`);
  assert.equal(readyRes.ok, true);
  const readyPayload = await readyRes.json();
  assert.equal(readyPayload.ok, true);
  assert.equal(typeof readyPayload.ready, 'boolean');
  assert.equal(typeof readyPayload.accounts, 'object');

  const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: { authorization: 'Bearer dummy' }
  });
  assert.equal(modelsRes.ok, true);
  assert.equal(Boolean(modelsRes.headers.get('x-aih-request-id')), true);
  const models = await modelsRes.json();
  assert.equal(models.object, 'list');
  assert.equal(Array.isArray(models.data), true);
  assert.ok(models.data.length >= 1);

  const metricsRes = await fetch(`http://127.0.0.1:${port}/v0/management/metrics`);
  assert.equal(metricsRes.ok, true);
  const metrics = await metricsRes.json();
  assert.equal(metrics.ok, true);
  assert.ok(Number(metrics.totalRequests) >= 1);
});

test('server serve becomes healthy before slow model prewarm completes', async (t) => {
  const upstream = await startSlowModelsUpstream(t, 4500);
  const { port, getStderr } = await startProxy(t, ['--codex-base-url', upstream]);
  const startedAt = Date.now();
  const ready = await waitForHealth(port, 2500);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(ready, true, `server did not become healthy early: ${getStderr()}`);
  assert.ok(elapsedMs < 3000, `healthz was blocked by startup prewarm (${elapsedMs}ms)`);
});

test('server serve enforces client and management keys when configured', async (t) => {
  const upstream = await startMockUpstream(t);
  const { port, getStderr } = await startProxy(t, [
    '--codex-base-url', upstream,
    '--client-key', 'client-secret',
    '--management-key', 'mgmt-secret'
  ]);
  const ready = await waitForHealth(port, 12000);
  assert.equal(ready, true, `server did not become healthy: ${getStderr()}`);

  const unauthorizedClientRes = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(unauthorizedClientRes.status, 401);
  assert.deepEqual(await unauthorizedClientRes.json(), {
    ok: false,
    error: 'unauthorized_client'
  });

  const authorizedClientRes = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: { authorization: 'Bearer client-secret' }
  });
  assert.equal(authorizedClientRes.status, 200);
  const modelPayload = await authorizedClientRes.json();
  assert.equal(modelPayload.object, 'list');

  const unauthorizedMgmtRes = await fetch(`http://127.0.0.1:${port}/v0/management/metrics`);
  assert.equal(unauthorizedMgmtRes.status, 401);
  assert.deepEqual(await unauthorizedMgmtRes.json(), {
    ok: false,
    error: 'unauthorized_management'
  });

  const authorizedMgmtRes = await fetch(`http://127.0.0.1:${port}/v0/management/metrics`, {
    headers: { authorization: 'Bearer mgmt-secret' }
  });
  assert.equal(authorizedMgmtRes.status, 200);
  const metrics = await authorizedMgmtRes.json();
  assert.equal(metrics.ok, true);
  assert.ok(Number(metrics.totalRequests) >= 1);
});

test('server serve forwards upstream unsupported endpoint errors and records failures', async (t) => {
  const deadUpstreamPort = await getFreePort();
  const upstream = `http://127.0.0.1:${deadUpstreamPort}`;
  const { port, getStderr } = await startProxy(t, ['--codex-base-url', upstream]);
  const ready = await waitForHealth(port, 12000);
  assert.equal(ready, true, `server did not become healthy: ${getStderr()}`);

  const unsupportedRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer dummy',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-dynamic',
      messages: [{ role: 'user', content: 'hello' }]
    })
  });
  assert.ok(unsupportedRes.status >= 400);
  await unsupportedRes.json();

  const metricsRes = await fetch(`http://127.0.0.1:${port}/v0/management/metrics`);
  assert.equal(metricsRes.status, 200);
  const metrics = await metricsRes.json();
  assert.equal(metrics.ok, true);
  assert.ok(Number(metrics.totalFailures) >= 1);
  const routeErrors = Array.isArray(metrics.lastErrors) ? metrics.lastErrors : [];
  assert.ok(routeErrors.length >= 1);
});

test('server shutdown keeps codex desktop hook enabled across restarts', async (t) => {
  const upstream = await startMockUpstream(t);
  const { child, port, testHome, getStderr } = await startProxy(t, ['--codex-base-url', upstream]);
  const { aiHomeDir, targetBinaryPath } = seedFakeCodexDesktopBundle(testHome);
  const ready = await waitForHealth(port, 12000);
  assert.equal(ready, true, `server did not become healthy: ${getStderr()}`);

  const statePath = path.join(aiHomeDir, 'codex-desktop-hook-state.json');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !fs.existsSync(statePath)) {
    await sleep(100);
  }
  assert.equal(fs.existsSync(statePath), true, 'expected hook state file to be created');
  assert.equal(fs.existsSync(`${targetBinaryPath}.aih-original`), true, 'expected wrapper install');

  const beforeStop = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(beforeStop.enabled, true);

  try { child.kill('SIGTERM'); } catch (_error) {}
  await new Promise((resolve) => child.once('exit', resolve));

  const afterStop = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(afterStop.enabled, true);
});

test('server startup reinstalls codex cli hook after global shim is overwritten', async (t) => {
  const upstream = await startMockUpstream(t);
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-bin-'));
  const fakeCodexPath = path.join(fakeBinDir, 'codex');
  fs.writeFileSync(fakeCodexPath, '#!/bin/sh\necho cli-original\n', 'utf8');
  fs.chmodSync(fakeCodexPath, 0o755);
  t.after(() => {
    try { fs.rmSync(fakeBinDir, { recursive: true, force: true }); } catch (_error) {}
  });

  const { port, testHome, getStderr } = await startProxy(
    t,
    ['--codex-base-url', upstream],
    { PATH: `${fakeBinDir}:${process.env.PATH || ''}` }
  );
  const ready = await waitForHealth(port, 12000);
  assert.equal(ready, true, `server did not become healthy: ${getStderr()}`);

  const statePath = path.join(testHome, '.ai_home', 'codex-cli-hook-state.json');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !fs.existsSync(statePath)) {
    await sleep(100);
  }
  assert.equal(fs.existsSync(statePath), true, 'expected cli hook state file to be created');
  assert.equal(fs.existsSync(`${fakeCodexPath}.aih-original`), true, 'expected cli wrapper install');
  assert.equal(fs.readFileSync(fakeCodexPath, 'utf8').includes('aih-codex-cli-hook'), true);
  assert.equal(fs.readFileSync(`${fakeCodexPath}.aih-original`, 'utf8'), '#!/bin/sh\necho cli-original\n');
});

test('server self-heals codex cli hook while running after shim is overwritten', async (t) => {
  const upstream = await startMockUpstream(t);
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-bin-'));
  const fakeCodexPath = path.join(fakeBinDir, 'codex');
  fs.writeFileSync(fakeCodexPath, '#!/bin/sh\necho cli-original\n', 'utf8');
  fs.chmodSync(fakeCodexPath, 0o755);
  t.after(() => {
    try { fs.rmSync(fakeBinDir, { recursive: true, force: true }); } catch (_error) {}
  });

  const { port, getStderr } = await startProxy(
    t,
    ['--codex-base-url', upstream],
    {
      PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      AIH_SERVER_CODEX_CLI_HOOK_SELF_HEAL_INTERVAL_MS: '200'
    }
  );
  const ready = await waitForHealth(port, 12000);
  assert.equal(ready, true, `server did not become healthy: ${getStderr()}`);

  const deadlineInstall = Date.now() + 5000;
  while (Date.now() < deadlineInstall && !fs.readFileSync(fakeCodexPath, 'utf8').includes('aih-codex-cli-hook')) {
    await sleep(60);
  }
  assert.equal(fs.readFileSync(fakeCodexPath, 'utf8').includes('aih-codex-cli-hook'), true, 'expected initial cli wrapper install');

  fs.writeFileSync(fakeCodexPath, '#!/bin/sh\necho overwritten-during-runtime\n', 'utf8');
  fs.chmodSync(fakeCodexPath, 0o755);

  const deadlineRepair = Date.now() + 5000;
  while (Date.now() < deadlineRepair && !fs.readFileSync(fakeCodexPath, 'utf8').includes('aih-codex-cli-hook')) {
    await sleep(60);
  }
  assert.equal(fs.readFileSync(fakeCodexPath, 'utf8').includes('aih-codex-cli-hook'), true, 'expected runtime self-heal to restore cli wrapper');
  assert.equal(
    fs.readFileSync(`${fakeCodexPath}.aih-original`, 'utf8'),
    '#!/bin/sh\necho overwritten-during-runtime\n'
  );
});

test('server self-heals codex desktop hook while running after wrapper is overwritten', async (t) => {
  const upstream = await startMockUpstream(t);
  const { port, testHome, getStderr } = await startProxy(
    t,
    ['--codex-base-url', upstream],
    {
      AIH_SERVER_CODEX_DESKTOP_HOOK_SELF_HEAL_INTERVAL_MS: '200',
      AIH_SERVER_CODEX_DESKTOP_TRACE_FILE: '/tmp/codex-app-server-trace.jsonl',
      AIH_SERVER_CODEX_DESKTOP_TRACE_RESPONSES: '1'
    }
  );
  const { aiHomeDir, targetBinaryPath } = seedFakeCodexDesktopBundle(testHome);
  const ready = await waitForHealth(port, 12000);
  assert.equal(ready, true, `server did not become healthy: ${getStderr()}`);

  const statePath = path.join(aiHomeDir, 'codex-desktop-hook-state.json');
  const deadlineInstall = Date.now() + 5000;
  while (Date.now() < deadlineInstall && !fs.existsSync(statePath)) {
    await sleep(60);
  }
  assert.equal(fs.existsSync(statePath), true, 'expected desktop hook state file to be created');

  const initialState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(initialState.traceFile, '/tmp/codex-app-server-trace.jsonl');
  assert.equal(initialState.traceResponses, true);
  assert.equal(fs.readFileSync(targetBinaryPath, 'utf8').includes('aih-codex-desktop-hook'), true);

  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho overwritten-desktop-runtime\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const deadlineRepair = Date.now() + 5000;
  while (Date.now() < deadlineRepair && !fs.readFileSync(targetBinaryPath, 'utf8').includes('aih-codex-desktop-hook')) {
    await sleep(60);
  }

  const repairedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(fs.readFileSync(targetBinaryPath, 'utf8').includes('aih-codex-desktop-hook'), true, 'expected runtime self-heal to restore desktop wrapper');
  assert.equal(repairedState.traceFile, '/tmp/codex-app-server-trace.jsonl');
  assert.equal(repairedState.traceResponses, true);
});
