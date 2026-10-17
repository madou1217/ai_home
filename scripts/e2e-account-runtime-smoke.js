'use strict';

// 真机 E2E 冒烟：起真 server（临时 AIH_HOME_DIR、指定管理密钥、随机端口），只用 HTTP 走通
//   1) 指向第三方中转的 API Key 账号 → customUpstream=true；
//   2) 账号级「恢复调度」清掉运行态阻塞（含 routingBlock）；
//   3) 「刷新账号」的模型轻探测在上游不可达时**只提示、不记账**，job 如实报告分支失败。
// 用法：node scripts/e2e-account-runtime-smoke.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const fsExtra = require('fs-extra');

const { startLocalServer } = require('../lib/server/server');
const {
  readAccountCredentialRecord,
  writeAccountCredentials
} = require('../lib/server/account-credential-store');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { createAccountStateService } = require('../lib/account/state-service');
const { loadServerRuntimeAccounts } = require('../lib/server/accounts');
const { applyReloadState } = require('../lib/server/management');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');
const { createProcessCapture } = require('../test/helpers/local-server-harness');

const MANAGEMENT_KEY = 'e2e-management-key-that-is-long-enough';

// 真依赖：账号池、账号状态索引/服务、checkStatus、profile 目录都走生产实现；
// 只把「会 fork 子进程 / 拉起外部服务」的那几项替身化，保证 smoke 只碰本进程。
function createDeps(aiHomeDir) {
  const processObj = createProcessCapture();
  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs: fsExtra });
  const accountStateService = createAccountStateService({ accountStateIndex });
  const profileDir = (provider, accountRef) => resolveAccountRuntimeDir(aiHomeDir, provider, accountRef);
  return {
    accountStateIndex,
    accountStateService,
    deps: {
      http,
      fs: fsExtra,
      path,
      aiHomeDir,
      hostHomeDir: aiHomeDir,
      processObj,
      spawn() { throw new Error('unexpected_spawn'); },
      spawnSync() { return { status: 1, stdout: '', stderr: '' }; },
      resolveCliPath: () => '',
      logFile: path.join(aiHomeDir, 'logs', 'server.log'),
      entryFilePath: path.join(process.cwd(), 'bin', 'ai-home.js'),
      nodeExecPath: process.execPath,
      getToolConfigDir: profileDir,
      getProfileDir: profileDir,
      checkStatus(provider, accountRef) {
        const record = readAccountCredentialRecord(fsExtra, aiHomeDir, accountRef);
        const configured = Boolean(record && (
          Object.keys(record.env || {}).length > 0 || Object.keys(record.nativeAuth || {}).length > 0
        ));
        return { configured, apiKeyMode: configured && Object.keys(record.env || {}).length > 0 };
      },
      accountStateService,
      accountStateIndex,
      loadServerRuntimeAccounts: (args) => loadServerRuntimeAccounts({
        ...args,
        fs: fsExtra,
        aiHomeDir,
        accountStateIndex,
        accountStateService
      }),
      applyReloadState,
      fetchImpl: async () => ({ ok: false, status: 404, text: async () => '{}' }),
      ensureSessionStoreLinks: () => {},
      syncGlobalConfigToHost: () => {},
      accountArtifactHooks: {},
      enableCodexDesktopAppHook: false,
      enableCodexCliHook: false,
      loadOrCreateServerIdentity: () => ({ id: 'e2e-smoke', name: 'E2E Smoke' }),
      readOutboundRelayConfig: () => ({ version: 1, relays: [] }),
      createOutboundRelayManager: () => ({ async start() {}, async stop() {}, getSnapshot: () => ({ running: true, relays: [] }) }),
      restorePersistentSessions: () => ({ restored: 0 }),
      setInterval(callback, delay) { const timer = { callback, delay, unref() {} }; return timer; },
      clearInterval() {}
    }
  };
}

function getFreePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: {
        authorization: `Bearer ${MANAGEMENT_KEY}`,
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {})
      }
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_error) { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}


async function main() {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-e2e-'));
  const port = await getFreePort();
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'e2e:codex:relay@example.com'
  });
  // 第三方中转（不可达）：轻探测必然失败，用来验证「失败只提示不记账」。
  writeAccountCredentials(fs, aiHomeDir, accountRef, {
    OPENAI_API_KEY: 'sk-e2e-relay',
    OPENAI_BASE_URL: 'http://127.0.0.1:1/v1'
  });
  // 先造一个运行态阻塞（等价于线上被 billing 阻塞），供 restore-scheduling 清理。
  const { deps, accountStateIndex: stateIndex } = createDeps(aiHomeDir);
  stateIndex.upsertRuntimeState(accountRef, 'codex', {
    cooldownUntil: Date.now() + 86_400_000,
    rateLimitUntil: Date.now() + 86_400_000,
    lastFailureKind: 'billing_blocked',
    lastFailureReason: 'billing_blocked',
    lastFailureAt: Date.now(),
    consecutiveFailures: 3,
    routingBlock: { kind: 'billing_blocked', reason: 'billing_blocked', observedAt: Date.now() }
  }, { configured: true, apiKeyMode: true, displayName: 'relay.e2e' });

  const handle = await startLocalServer({
    host: '127.0.0.1',
    port,
    managementKey: MANAGEMENT_KEY,
    manageProcessLifecycle: false,
    backend: 'codex-adapter',
    provider: 'codex',
    providerMode: 'codex',
    strategy: 'random',
    codexClientVersion: '0.0.0-e2e',
    modelUsageScan: false,
    providerCliAutoUpgrade: false,
    logRequests: false
  }, deps);

  const report = { aiHomeDir, port, accountRef };
  try {
    const list = await request(port, 'GET', '/v0/webui/accounts');
    assert.equal(list.status, 200, `accounts list: ${list.status} ${list.text.slice(0, 200)}`);
    const account = (list.json.accounts || []).find((item) => item.accountRef === accountRef);
    assert.ok(account, 'E2E 账号必须在列表里');
    report.customUpstream = account.customUpstream;
    assert.equal(account.customUpstream, true, '指向第三方中转的 API Key 账号必须 customUpstream=true');
    report.runtimeBefore = { status: account.runtimeStatus, reason: account.runtimeReason };
    assert.equal(account.runtimeStatus, 'billing_blocked', '阻塞态必须先在账号记录里可见');

    const restored = await request(port, 'POST', `/v0/webui/accounts/codex/${accountRef}/restore-scheduling`);
    assert.equal(restored.status, 200, `restore: ${restored.status} ${restored.text.slice(0, 200)}`);
    assert.equal(restored.json.ok, true);
    report.restoredAccount = {
      runtimeStatus: restored.json.account && restored.json.account.runtimeStatus,
      runtimeReason: restored.json.account && restored.json.account.runtimeReason
    };
    const rowAfterRestore = stateIndex.getAccountState(accountRef);
    report.runtimeStateAfterRestore = rowAfterRestore && rowAfterRestore.runtimeState;
    const restoredState = (rowAfterRestore && rowAfterRestore.runtimeState) || {};
    assert.equal(Number(restoredState.cooldownUntil) || 0, 0, '恢复调度后冷却必须归零');
    assert.equal(Number(restoredState.rateLimitUntil) || 0, 0, '恢复调度后限流冷却必须归零');
    assert.equal(restoredState.routingBlock || null, null, '恢复调度后 routingBlock 必须清空');
    assert.equal(String(restoredState.lastFailureKind || ''), '', '恢复调度后失败种类必须清空');

    const refresh = await request(port, 'POST', `/v0/webui/accounts/codex/${accountRef}/refresh`);
    assert.equal(refresh.status, 202, `refresh: ${refresh.status} ${refresh.text.slice(0, 200)}`);
    const jobId = refresh.json.job && refresh.json.job.id;
    let job = refresh.json.job;
    for (let i = 0; i < 60 && job && (job.status === 'queued' || job.status === 'running'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const events = await request(port, 'GET', `/v0/webui/accounts/${jobId}/refresh`);
      if (events.json && events.json.job) job = events.json.job;
      else break;
    }
    report.refreshJob = job && {
      status: job.status,
      branches: job.branches,
      recovered: job.recovered,
      error: job.error
    };
    const rowAfterProbe = stateIndex.getAccountState(accountRef);
    report.runtimeStateAfterProbe = rowAfterProbe && rowAfterProbe.runtimeState;
    const probedState = (rowAfterProbe && rowAfterProbe.runtimeState) || {};
    assert.equal(
      `${Number(probedState.cooldownUntil) || 0}|${Number(probedState.authInvalidUntil) || 0}|${String(probedState.lastFailureKind || '')}`,
      '0|0|',
      '轻探测失败不得给账号记账（只提示）'
    );
    const listAfter = await request(port, 'GET', '/v0/webui/accounts');
    const accountAfter = (listAfter.json.accounts || []).find((item) => item.accountRef === accountRef);
    report.accountAfterProbe = {
      runtimeStatus: accountAfter && accountAfter.runtimeStatus,
      schedulableStatus: accountAfter && accountAfter.schedulableStatus
    };
    // 账号仍可调度：runtimeStatus 只会是 healthy/未发布，绝不能是被探测失败「标记」出来的异常态。
    const afterStatus = String((accountAfter && accountAfter.runtimeStatus) || '');
    assert.ok(
      afterStatus === '' || afterStatus === 'healthy',
      `探测失败后账号不得被标记异常（实际 ${afterStatus}）`
    );
    assert.notEqual(String((accountAfter && accountAfter.schedulableStatus) || ''), 'blocked_by_policy');
  } finally {
    await handle.stop('e2e');
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write('[e2e] OK\n');
}

main().catch((error) => {
  process.stderr.write(`[e2e] FAILED: ${String((error && error.stack) || error)}\n`);
  process.exitCode = 1;
});
