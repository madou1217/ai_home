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

async function startProxy(t, extraArgs = []) {
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
      no_proxy: '127.0.0.1,localhost'
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

  return { child, port, getStderr: () => stderr };
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
