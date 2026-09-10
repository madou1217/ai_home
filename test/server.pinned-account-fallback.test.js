'use strict';

/**
 * 钉选账号失效时的回落策略(2026-09-11 用户裁决:钉选是亲和偏好,不是死刑)。
 *
 * 背景:会话把 x-account-ref 钉在一个账号上,该账号被停用/删除后,旧行为是
 * 403/404 硬死——明明池里还有两个健康账号也照样拒服。新契约:
 *   - 同 provider 池还有别的可调度账号 → 摘钉回落,正常服务;
 *   - 一个可调度账号都没有 → 才报精确的 pinned_account_unavailable(403)
 *     或 unknown_account_ref(404);
 *   - 安全性质不变:死账号的陈旧凭据永不出站(常池选择经持久化生命周期同步)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('fs-extra');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { startLocalServer } = require('../lib/server/server');
const { handleCodexResponsesWebSocket } = require('../lib/server/codex-responses-websocket');

async function getFreePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}

function createProcessCapture() {
  const processObj = new EventEmitter();
  processObj.env = { AIH_SERVER_DISABLE_SOURCE_AUTO_RESTART: '1' };
  processObj.argv = ['node', 'bin/ai-home.js', '__background', 'run'];
  processObj.execPath = process.execPath;
  processObj.pid = process.pid;
  processObj.cwd = () => process.cwd();
  processObj.kill = (pid) => {
    if (Number(pid) === process.pid) return true;
    const error = new Error('ESRCH');
    error.code = 'ESRCH';
    throw error;
  };
  processObj.exitCalls = [];
  processObj.exit = (code) => processObj.exitCalls.push(code);
  return processObj;
}

test('钉住的账号停用后,请求回落到同 provider 的健康账号,且死账号凭据不出站', async (t) => {
  const { registerAccountIdentity } = require('../lib/account/account-registration');
  const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
  const { createAccountStateIndex } = require('../lib/account/state-index');
  const { createAccountStateService } = require('../lib/account/state-service');
  const { loadServerRuntimeAccounts } = require('../lib/server/accounts');
  const { applyReloadState } = require('../lib/server/management');

  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-pin-fallback-'));
  const processObj = createProcessCapture();
  const lifecycle = {
    relayClosed: 0, webrtcClosed: 0, fabricClosed: 0, mdnsStopped: 0,
    outboundStopped: 0, frpStopped: 0, logTimers: new Set(), logTimersCleared: 0
  };
  const mkAccount = (cliId, uuid, email) => {
    const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
      provider: 'claude', cliAccountId: cliId, identitySeed: `oauth:claude:uuid:${uuid}`
    });
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: { claudeAiOauth: {
      accessToken: `access-${cliId}`, refreshToken: `refresh-${cliId}`, expiresAt: Date.now() + 7200_000,
      account: { uuid, emailAddress: email }
    } } });
    return accountRef;
  };
  const deadRef = mkAccount('1', '11111111-1111-4111-8111-111111111111', 'dead@example.com');
  const liveRef = mkAccount('2', '22222222-2222-4222-8222-222222222222', 'live@example.com');

  const port = await getFreePort();
  let handle;
  const upstreamTokens = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    if (req.url !== '/v1/messages') { res.writeHead(404); res.end('{}'); return; }
    upstreamTokens.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'test-message', type: 'message', role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'text', text: 'served-by-fallback' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 }
    }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (handle) await handle.stop('test-cleanup');
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  // 与 server-lifecycle.test.js 同款的最小依赖(那是它的私有助手,这里内联,不跨文件复用)
  const deps = (() => {
    const sessionEventBus = new EventEmitter();
    sessionEventBus.off = sessionEventBus.off.bind(sessionEventBus);
    return {
      http, fs, path, aiHomeDir, hostHomeDir: aiHomeDir, processObj,
      spawn() { throw new Error('unexpected_spawn'); },
      spawnSync() { return { status: 1, stdout: '', stderr: '' }; },
      resolveCliPath: () => '',
      logFile: path.join(aiHomeDir, 'logs', 'server.log'),
      lifecycle,
      sessionEventBus,
      accountRuntimeEvents: new EventEmitter(),
      loadServerRuntimeAccounts,
      applyReloadState,
      checkStatus: () => ({ configured: true, accountName: 'live@example.com' })
    };
  })();

  handle = await startLocalServer({
    host: '127.0.0.1',
    port,
    provider: 'claude',
    backend: 'passthrough',
    strategy: 'random',
    codexClientVersion: '0.0.0-test',
    managementKey: 'management-key-that-is-long-enough',
    modelUsageScan: false,
    logRequests: false,
    manageProcessLifecycle: false,
    clientKey: 'test-client-key',
    noProxy: true,
    upstreamTimeoutMs: 5000,
    claudeBaseUrl: `http://127.0.0.1:${upstream.address().port}`
  }, deps);

  // 建持久化状态行(setStatus 是 UPDATE-only,行不存在则静默无效——
  // 上一轮 404 就是这么来的):先两个账号都建行并置 up,再停掉被钉的那个
  const index = createAccountStateIndex({ fs, aiHomeDir });
  const stateService = createAccountStateService({ accountStateIndex: index });
  stateService.recordRuntimeSuccess(deadRef, 'claude', { configured: true, authMode: 'oauth' });
  stateService.recordRuntimeSuccess(liveRef, 'claude', { configured: true, authMode: 'oauth' });
  index.setStatus(deadRef, 'down');
  index.setStatus(liveRef, 'up');
  index.close();

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'test-client-key',
      'x-account-ref': deadRef
    },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'continue' }] }),
    signal: AbortSignal.timeout(8000)
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.content[0].text, 'served-by-fallback');
  // 死账号的陈旧凭据不得出站;上游只能看到活账号的 token
  assert.deepEqual(upstreamTokens, ['Bearer access-2']);
});

test('WS /v1/responses:钉的账号不在可调度池时回落全池,而不是把池过滤成零', async () => {
  const pools = [];
  const written = [];
  const fakeSocket = {
    destroyed: false,
    write(chunk) { written.push(chunk); },
    end(chunk) { written.push(chunk); this.destroy(); },
    destroy() { this.destroyed = true; }
  };
  const liveAccount = { accountRef: 'acct_live', accessToken: 'tok-live', openaiBaseUrl: '' };
  await handleCodexResponsesWebSocket(
    { req: { headers: { 'x-account-ref': 'acct_dead' } }, socket: fakeSocket, head: Buffer.alloc(0),
      state: { accounts: { codex: [liveAccount] }, cursors: {} },
      options: { codexBaseUrl: '' } },
    {
      chooseAccount: (pool) => {
        pools.push(pool.map((a) => a.accountRef));
        return null; // 只关心传进去的池,不真的连上游
      },
      isLoopbackUrl: () => false,
      accountActivity: null,
      onError: () => {}
    }
  );
  // 旧契约:池被死钉过滤成 [] → 直接 503;新契约:回落全池 [acct_live]
  assert.deepEqual(pools[0], ['acct_live']);
  assert.ok(written.some((chunk) => String(chunk).includes('503')), 'chooseAccount 返回空仍应 503');
});
