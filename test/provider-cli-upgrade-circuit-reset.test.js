'use strict';

// 熔断是终局状态,此前没有任何入口可以解除,只能手改账本。解除前必须用同一套验证器
// 验证当前会被启动的 CLI,只有明确通过才解除并记为新的回退锚点。

const test = require('node:test');
const assert = require('node:assert/strict');

const { clearBrokenProvider } = require('../lib/server/provider-cli-upgrade/upgrade-circuit-reset');
const { emptyLedger, readProviderRecord, writeProviderRecord } = require('../lib/server/provider-cli-upgrade/upgrade-ledger');
const { VERDICTS } = require('../lib/server/provider-cli-upgrade/upgrade-verifier');
const { createProviderCliUpgradeScheduler } = require('../lib/server/provider-cli-upgrade-scheduler');

function brokenLedger() {
  return writeProviderRecord(emptyLedger(), 'codex', {
    state: 'broken',
    channel: 'standalone_release',
    installedVersion: 'codex-cli 0.154.0-alpha.3',
    knownGoodVersion: 'codex-cli 0.154.0-alpha.3',
    lastApplyError: 'rollback_plan_unavailable',
    enabled: false,
    disabledReason: 'rollback_plan_unavailable',
    blockedVersions: ['0.158.0', '0.157.0']
  });
}

function deps(verdict, version = '0.158.0') {
  const verified = [];
  return {
    verified,
    probeInstalledVersion: async () => version,
    verify: async (provider, expected) => { verified.push([provider, expected]); return verdict; }
  };
}

test('验证通过才解除熔断,并把当前版本记为回退锚点', async () => {
  const d = deps({ verdict: VERDICTS.PASS, detail: 'app_server_listening' });
  const result = await clearBrokenProvider('codex', brokenLedger(), d, 1_000);

  assert.equal(result.ok, true);
  assert.deepEqual(d.verified, [['codex', '0.158.0']]);
  const record = readProviderRecord(result.ledger, 'codex');
  assert.equal(record.state, 'healthy');
  assert.equal(record.installedVersion, '0.158.0');
  assert.equal(record.knownGoodVersion, '0.158.0');
  assert.equal(record.knownGoodRollbackable, true);
  assert.equal(record.lastApplyError, '');
  assert.equal(record.history.at(-1).outcome, 'cleared');
  // 熔断落的三处都要恢复,否则自动升级仍停着
  assert.equal(record.enabled, true);
  assert.equal(record.disabledReason, '');
  assert.deepEqual(record.blockedVersions, ['0.157.0']);
});

// 回归:此前手工解除只改回了 state,enabled 仍为 false、0.158.0 仍在黑名单,自动升级实际停着。
test('state 已改回但 enabled 仍为 false 的半解除账本也能解除', async () => {
  const half = writeProviderRecord(brokenLedger(), 'codex', { state: 'healthy' });
  const result = await clearBrokenProvider('codex', half, deps({ verdict: VERDICTS.PASS }));
  assert.equal(result.ok, true);
  assert.equal(readProviderRecord(result.ledger, 'codex').enabled, true);
});

test('验证失败或未能确证时保持熔断,并给出原因', async () => {
  const failed = await clearBrokenProvider('codex', brokenLedger(), deps({ verdict: VERDICTS.FAIL, detail: 'version_mismatch' }));
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'verify_failed');
  assert.equal(failed.detail, 'version_mismatch');
  assert.equal(readProviderRecord(failed.ledger, 'codex').state, 'broken');

  const unsure = await clearBrokenProvider('codex', brokenLedger(), deps({ verdict: VERDICTS.INCONCLUSIVE, detail: 'probe_failed' }));
  assert.equal(unsure.reason, 'verify_inconclusive');
  assert.equal(readProviderRecord(unsure.ledger, 'codex').state, 'broken');
});

test('没有熔断时不做任何事', async () => {
  const d = deps({ verdict: VERDICTS.PASS });
  const result = await clearBrokenProvider('codex', emptyLedger(), d);
  assert.equal(result.reason, 'not_broken');
  assert.deepEqual(d.verified, []);
});

test('调度器解除熔断与周期检查互斥,结果落盘', async () => {
  let stored = brokenLedger();
  const writes = [];
  let releaseVerify;
  const scheduler = createProviderCliUpgradeScheduler({
    aiHomeDir: '/tmp/unused',
    providers: ['codex'],
    readLedger: () => stored,
    writeLedger: (_dir, ledger) => { writes.push(ledger); stored = ledger; },
    deps: {
      probeInstalledVersion: async () => '0.158.0',
      verify: () => new Promise((resolve) => { releaseVerify = () => resolve({ verdict: VERDICTS.PASS }); })
    },
    config: { enabled: true }
  });

  const pending = scheduler.clearBroken('codex');
  assert.equal(scheduler.getState().cycling, true);
  assert.deepEqual(await scheduler.clearBroken('codex'), { ok: false, reason: 'already_running' });
  assert.equal((await scheduler.runNow('test')).reason, 'already_running');
  releaseVerify();
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(readProviderRecord(stored, 'codex').state, 'healthy');
  assert.equal(scheduler.getState().cycling, false);
  assert.equal((await scheduler.clearBroken('gemini')).reason, 'unknown_provider');
});
