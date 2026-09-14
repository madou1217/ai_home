'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ROUTE_PATH,
  buildProviderCliUpgradeStatus,
  handleProviderCliUpgradeRoutes
} = require('../lib/server/webui-provider-cli-upgrade-routes');
const { ledgerPath, emptyLedger, writeLedger } = require('../lib/server/provider-cli-upgrade/upgrade-ledger');

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-upgrade-routes-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 只造一个够用的假 ctx：这条路由的全部输入就是 fs + aiHomeDir + 可选的调度器。
function makeCtx(overrides = {}) {
  const written = [];
  return {
    ctx: {
      method: 'GET',
      pathname: ROUTE_PATH,
      res: {},
      fs,
      writeJson: (_res, status, payload) => written.push({ status, payload }),
      ...overrides
    },
    written
  };
}

function seedLedger(aiHomeDir, providers, global) {
  let ledger = { ...emptyLedger(), ...(global ? { global } : {}) };
  ledger = { ...ledger, providers };
  writeLedger(aiHomeDir, ledger, { fs, path });
  return ledger;
}

test('GET 返回账本与调度器状态', async () => {
  const aiHomeDir = tempHome();
  seedLedger(aiHomeDir, {
    codex: { state: 'healthy', channel: 'standalone_release', installedVersion: '0.153.4', latestVersion: '0.154.0', lastCheckAt: 123 }
  });
  const scheduler = {
    getState: () => ({
      running: true, cycling: false, enabled: true, applyEnabled: false,
      intervalMs: 6 * 60 * 60 * 1000, startDelayMs: 5 * 60 * 1000, tickCount: 2,
      providers: ['codex', 'gemini'],
      lastResult: { at: 9, reason: 'interval', applyEnabled: false, providers: { codex: { state: 'healthy', reason: 'apply_disabled' } } },
      lastError: ''
    })
  };
  const { ctx, written } = makeCtx({ aiHomeDir, deps: { providerCliUpgradeScheduler: scheduler } });

  assert.equal(await handleProviderCliUpgradeRoutes(ctx), true);
  assert.equal(written.length, 1);
  assert.equal(written[0].status, 200);

  const payload = written[0].payload;
  assert.equal(payload.ok, true);
  assert.equal(payload.scheduler.applyEnabled, false);
  assert.equal(payload.scheduler.tickCount, 2);
  // 调度器候选 ∪ 账本键，顺序以调度器为准。
  assert.deepEqual(payload.providers.map((item) => item.provider), ['codex', 'gemini']);

  const codex = payload.providers[0];
  assert.equal(codex.installedVersion, '0.153.4');
  assert.equal(codex.updateAvailable, true);
  assert.equal(codex.lastTickReason, 'apply_disabled');
  // 账本里没有的 provider 也要出现，字段取默认值（页面据此显示「待首轮检查」）。
  assert.equal(payload.providers[1].state, 'unknown');
  assert.equal(payload.providers[1].lastCheckAt, 0);
});

// 账本第一次写出来之前（server 起来的头几分钟）不能是空白页。
test('账本还不存在时按调度器候选列出 provider', async () => {
  const aiHomeDir = tempHome();
  assert.equal(fs.existsSync(ledgerPath(aiHomeDir)), false);
  const scheduler = { getState: () => ({ enabled: true, applyEnabled: false, providers: ['codex'], lastResult: null, lastError: '' }) };
  const status = buildProviderCliUpgradeStatus({ fs, aiHomeDir, deps: { providerCliUpgradeScheduler: scheduler } });

  assert.equal(status.ok, true);
  assert.equal(status.global.enabled, true);
  assert.deepEqual(status.providers.map((item) => item.provider), ['codex']);
  assert.equal(status.providers[0].updateAvailable, false);
});

// 没有 server 实例（或调度器没起）时，账本那半边仍然要能读出来。
test('没有调度器时降级为 scheduler: null 而不是报错', async () => {
  const aiHomeDir = tempHome();
  seedLedger(aiHomeDir, { gemini: { state: 'healthy', installedVersion: '1.2.3', latestVersion: '1.2.3' } });
  const status = buildProviderCliUpgradeStatus({ fs, aiHomeDir });

  assert.equal(status.scheduler, null);
  const gemini = status.providers.find((item) => item.provider === 'gemini');
  assert.equal(gemini.updateAvailable, false);
});

// 已拉黑的版本闭环永远不会再装，显示成「有新版」只会让人白等。
test('被拉黑的版本不算「有新版可用」', () => {
  const aiHomeDir = tempHome();
  seedLedger(aiHomeDir, {
    codex: { installedVersion: '0.153.4', latestVersion: '0.154.0', blockedVersions: ['0.154.0'] }
  });
  const status = buildProviderCliUpgradeStatus({ fs, aiHomeDir });
  const codex = status.providers.find((item) => item.provider === 'codex');

  assert.equal(codex.updateAvailable, false);
  assert.deepEqual(codex.blockedVersions, ['0.154.0']);
});

test('全局熔断如实上报', () => {
  const aiHomeDir = tempHome();
  seedLedger(aiHomeDir, {}, { enabled: false, disabledReason: 'manual' });
  const status = buildProviderCliUpgradeStatus({ fs, aiHomeDir });

  assert.equal(status.global.enabled, false);
  assert.equal(status.global.disabledReason, 'manual');
});

// 这是只读面：写操作一律 405，不给「点一下立刻升级」留后门。
test('非 GET 一律 405', async () => {
  const { ctx, written } = makeCtx({ method: 'POST', aiHomeDir: tempHome() });
  assert.equal(await handleProviderCliUpgradeRoutes(ctx), true);
  assert.equal(written[0].status, 405);
  assert.equal(written[0].payload.error, 'method_not_allowed');
});

test('别的路径不接管', async () => {
  const { ctx, written } = makeCtx({ pathname: '/v0/webui/toolkit/apps' });
  assert.equal(await handleProviderCliUpgradeRoutes(ctx), false);
  assert.equal(written.length, 0);
});

// history 最多 20 条，面板只要最近几条。
test('history 只回最近 5 条', () => {
  const aiHomeDir = tempHome();
  const history = Array.from({ length: 12 }, (_v, index) => ({ at: index, outcome: `n${index}` }));
  seedLedger(aiHomeDir, { codex: { history } });
  const status = buildProviderCliUpgradeStatus({ fs, aiHomeDir });

  assert.equal(status.providers.find((item) => item.provider === 'codex').history.length, 5);
  assert.equal(status.providers.find((item) => item.provider === 'codex').history[0].outcome, 'n7');
});
