'use strict';

// 插件网关测试共用：临时目录、打包测试插件，以及接假上游的真实 aih server（两个 claude OAuth 账号）。
// 全部在 /tmp 临时目录与随机端口上运行，不触碰用户的 ~/.ai_home 与 9527。

const { EventEmitter } = require('node:events');
const fs = require('fs-extra');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { buildArtifact } = require('../../lib/plugins/control/artifact');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', prefix));
}

function socketFor(dir) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\aih-plugin-m2-${path.basename(dir)}` : path.join(dir, 'h.sock');
}

function manifest(pluginId, extra = {}) {
  return {
    manifestVersion: 1, protocolVersion: 1, pluginId, version: '0.1.0',
    engines: { aih: '>=1.0.0' }, runtime: 'node', entry: 'index.mjs', contributes: [], ...extra
  };
}

function packPlugin(dir, name, pluginManifest, source) {
  const pluginDir = path.join(dir, 'src', name);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(pluginManifest));
  fs.writeFileSync(path.join(pluginDir, 'index.mjs'), source);
  return buildArtifact(pluginDir, path.join(dir, 'packages', `${name}.aih-plugin`)).file;
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

const MANAGEMENT_KEY = 'management-key-that-is-long-enough';

async function startClaudeServer(t) {
  const { startLocalServer } = require('../../lib/server/server');
  const { createProcessCapture, createServerDeps, createServeOptions, getFreePort } = require('./local-server-harness');
  const { registerAccountIdentity } = require('../../lib/account/account-registration');
  const { writeAccountNativeAuth } = require('../../lib/server/account-credential-store');
  const { createAccountStateIndex } = require('../../lib/account/state-index');
  const { createAccountStateService } = require('../../lib/account/state-service');
  const { loadServerRuntimeAccounts } = require('../../lib/server/accounts');
  const { applyReloadState } = require('../../lib/server/management');

  const dir = tempDir('aihm2e-');
  const aiHomeDir = path.join(dir, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const accountRefs = ['1', '2'].map((cliId) => {
    const uuid = `${cliId.repeat(8)}-${cliId.repeat(4)}-4${cliId.repeat(3)}-8${cliId.repeat(3)}-${cliId.repeat(12)}`;
    const { accountRef } = registerAccountIdentity(fs, aiHomeDir, { provider: 'claude', cliAccountId: cliId, identitySeed: `oauth:claude:uuid:${uuid}` });
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: { claudeAiOauth: {
      accessToken: `access-${cliId}`, refreshToken: `refresh-${cliId}`, expiresAt: Date.now() + 7200_000,
      account: { uuid, emailAddress: `m2-${cliId}@example.com` }
    } } });
    return accountRef;
  });

  const upstreamBodies = [];
  const upstreamTokens = [];
  // failures.remaining：接下来几次上游回 500；failures.headerDelayMs：成功响应写头前的等待（模拟首字节慢）。
  const failures = { remaining: 0, headerDelayMs: 0 };
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url !== '/v1/messages') { res.writeHead(404); res.end('{}'); return; }
      if (failures.remaining > 0) {
        failures.remaining -= 1;
        upstreamTokens.push(req.headers.authorization);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream exploded' } }));
        return;
      }
      upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      upstreamTokens.push(req.headers.authorization);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_m2', type: 'message', role: 'assistant', model: 'claude-opus-5',
          content: [{ type: 'text', text: 'served' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }
        }));
      }, failures.headerDelayMs);
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const port = await getFreePort();
  const lifecycle = { relayClosed: 0, webrtcClosed: 0, fabricClosed: 0, mdnsStopped: 0, outboundStopped: 0, frpStopped: 0, logTimers: new Set(), logTimersCleared: 0 };
  const handle = await startLocalServer(createServeOptions(port, {
    provider: 'claude', backend: 'passthrough', manageProcessLifecycle: false, managementKey: MANAGEMENT_KEY,
    clientKey: 'test-client-key', noProxy: true, upstreamTimeoutMs: 5000,
    claudeBaseUrl: `http://127.0.0.1:${upstream.address().port}`
  }), createServerDeps(aiHomeDir, createProcessCapture(), lifecycle, {
    loadServerRuntimeAccounts,
    applyReloadState,
    checkStatus: () => ({ configured: true, accountName: 'm2-1@example.com' }),
    accountRuntimeEvents: new EventEmitter()
  }));
  const index = createAccountStateIndex({ fs, aiHomeDir });
  const stateService = createAccountStateService({ accountStateIndex: index });
  for (const accountRef of accountRefs) {
    stateService.recordRuntimeSuccess(accountRef, 'claude', { configured: true, authMode: 'oauth' });
    index.setStatus(accountRef, 'up');
  }
  index.close();

  t.after(async () => {
    await handle.stop('test-cleanup');
    await new Promise((resolve) => upstream.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { if (!(process.platform === 'win32' && error.code === 'EBUSY')) throw error; }
  });
  const base = `http://127.0.0.1:${port}`;
  const management = async (route, body) => {
    const response = await fetch(`${base}/v0/plugins${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${MANAGEMENT_KEY}` },
      body: body ? JSON.stringify(body) : undefined
    });
    return response.json();
  };
  const message = (model, text) => fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-client-key' },
    body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: text }] }),
    signal: AbortSignal.timeout(10000)
  });
  return { dir, base, upstreamBodies, upstreamTokens, accountRefs, management, message, failures };
}

module.exports = { MANAGEMENT_KEY, tempDir, socketFor, manifest, packPlugin, waitFor, startClaudeServer };
