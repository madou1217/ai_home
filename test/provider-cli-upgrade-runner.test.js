'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CHANNELS } = require('../lib/server/provider-cli-upgrade/upgrade-channel');
const { emptyLedger, readProviderRecord } = require('../lib/server/provider-cli-upgrade/upgrade-ledger');
const {
  STATES,
  VERDICTS,
  runProviderUpgradeCycle
} = require('../lib/server/provider-cli-upgrade/upgrade-runner');

const NOW = 1_757_000_000_000;
const LONG_AGO = NOW - (10 * 24 * 60 * 60 * 1000);

// 所有依赖都是脚本化的假件：整条闭环（含回滚与熔断）不真装任何包。
function makeDeps(overrides = {}) {
  const calls = { plans: [], logs: [] };
  const deps = {
    now: () => NOW,
    detectChannel: async () => ({
      channel: CHANNELS.STANDALONE_RELEASE,
      pinnable: true,
      ownerPath: '/opt/codex/releases/0.153.4/bin/codex',
      resolvedPath: '/home/u/.local/bin/codex',
      shadowedNpmInstall: false
    }),
    checkUpdate: async () => ({
      installedVersion: '0.153.4',
      latestVersion: '0.154.0',
      publishedAt: LONG_AGO
    }),
    checkQuiescence: async () => ({ busy: false, evidence: [] }),
    runPlans: async (plans, context) => {
      calls.plans.push({ phase: context.phase, version: context.version });
      return { ok: true };
    },
    verify: async () => ({ verdict: VERDICTS.PASS }),
    log: (entry) => calls.logs.push(entry),
    ...overrides
  };
  return { deps, calls };
}

// 静默闸门要求连续两次观测到闲，所以 happy path 需要跑两轮。
async function runTwice(ledger, deps, config) {
  let state = ledger;
  let last = null;
  for (let i = 0; i < 2; i += 1) {
    const result = await runProviderUpgradeCycle('codex', state, deps, config);
    state = result.ledger;
    last = result;
  }
  return { ledger: state, result: last };
}

test('happy path：连续两次静默后升级并推进 knownGood', async () => {
  const { deps, calls } = makeDeps();
  const { ledger, result } = await runTwice(emptyLedger(), deps);

  assert.equal(result.state, STATES.HEALTHY);
  assert.equal(result.reason, 'verified_pass');
  const record = readProviderRecord(ledger, 'codex');
  assert.equal(record.installedVersion, '0.154.0');
  assert.equal(record.knownGoodVersion, '0.154.0');
  assert.deepEqual(calls.plans, [{ phase: 'upgrade', version: '0.154.0' }]);
});

test('第一次观测到静默还不动手,只记 tick', async () => {
  const { deps, calls } = makeDeps();
  const result = await runProviderUpgradeCycle('codex', emptyLedger(), deps);

  assert.equal(result.state, STATES.DEFERRED);
  assert.equal(result.reason, 'awaiting_quiescence');
  assert.deepEqual(calls.plans, []);
});

// 「绝不打断在跑的会话」的闸门。忙不能计入熔断,否则常年繁忙的机器会把额度烧光。
test('provider 在跑时推迟,且不计入熔断', async () => {
  const { deps, calls } = makeDeps({
    checkQuiescence: async () => ({ busy: true, evidence: ['app_server:chat-acct_x'] })
  });
  const { ledger, result } = await runTwice(emptyLedger(), deps);

  assert.equal(result.state, STATES.DEFERRED);
  assert.equal(result.reason, 'deferred_busy');
  assert.deepEqual(calls.plans, []);
  assert.equal(readProviderRecord(ledger, 'codex').consecutiveFailures, 0);
});

test('验证失败 → 回滚到 knownGood → 该版本永久拉黑', async () => {
  const { deps, calls } = makeDeps({
    verify: async (_provider, version) => (
      version === '0.154.0' ? { verdict: VERDICTS.FAIL, detail: 'provider name must not be empty' } : { verdict: VERDICTS.PASS }
    )
  });
  const { ledger, result } = await runTwice(emptyLedger(), deps);

  assert.equal(result.state, STATES.ROLLED_BACK);
  assert.deepEqual(calls.plans, [
    { phase: 'upgrade', version: '0.154.0' },
    { phase: 'rollback', version: '0.153.4' }
  ]);
  const record = readProviderRecord(ledger, 'codex');
  assert.equal(record.installedVersion, '0.153.4');
  assert.ok(record.blockedVersions.includes('0.154.0'));
  assert.equal(record.history.at(-1).outcome, 'rolled_back');
});

test('拉黑后的版本不再被尝试', async () => {
  const { deps, calls } = makeDeps({
    verify: async (_p, v) => (v === '0.154.0' ? { verdict: VERDICTS.FAIL } : { verdict: VERDICTS.PASS })
  });
  const first = await runTwice(emptyLedger(), deps);
  calls.plans.length = 0;
  const again = await runTwice(first.ledger, deps);

  assert.equal(again.result.reason, 'version_blocked');
  assert.deepEqual(calls.plans, []);
});

// 回滚失败是终局：机器停在已知坏版本上，再装一次极可能只是重装同一个坏版本。
test('回滚安装失败 → broken 并熔断该 provider', async () => {
  const { deps } = makeDeps({
    verify: async (_p, v) => (v === '0.154.0' ? { verdict: VERDICTS.FAIL } : { verdict: VERDICTS.PASS }),
    runPlans: async (_plans, context) => (context.phase === 'rollback' ? { ok: false, stderr: 'boom' } : { ok: true })
  });
  const { ledger, result } = await runTwice(emptyLedger(), deps);

  assert.equal(result.state, STATES.BROKEN);
  assert.equal(result.reason, 'rollback_install_failed');
  const record = readProviderRecord(ledger, 'codex');
  assert.equal(record.enabled, false);
  assert.equal(record.disabledReason, 'rollback_install_failed');
});

// 基线验得过（否则根本不会起跳），升级后验不过，回滚装上了却依然验不过。
function verifyOnlyBaselineOnce() {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls === 1 ? { verdict: VERDICTS.PASS } : { verdict: VERDICTS.FAIL };
  };
}

test('回滚装上了但验证仍失败 → 同样 broken', async () => {
  const { deps } = makeDeps({ verify: verifyOnlyBaselineOnce() });
  const { result } = await runTwice(emptyLedger(), deps);

  assert.equal(result.state, STATES.BROKEN);
  assert.equal(result.reason, 'rollback_verify_failed');
});

test('已熔断的 provider 不再做任何动作', async () => {
  const { deps } = makeDeps({ verify: verifyOnlyBaselineOnce() });
  const broken = await runTwice(emptyLedger(), deps);
  const after = await runProviderUpgradeCycle('codex', broken.ledger, deps);

  assert.equal(after.reason, 'provider_broken');
});

// 没拿到成功信号 ≠ 拿到失败信号。超时/探针自身出错不该触发回滚。
test('验证 inconclusive 时放行,但 knownGood 不前进', async () => {
  const { deps, calls } = makeDeps({
    verify: async (_p, v) => (v === '0.154.0' ? { verdict: VERDICTS.INCONCLUSIVE } : { verdict: VERDICTS.PASS })
  });
  const { ledger, result } = await runTwice(emptyLedger(), deps);

  assert.equal(result.state, STATES.HEALTHY);
  assert.equal(result.reason, 'verified_inconclusive');
  assert.deepEqual(calls.plans, [{ phase: 'upgrade', version: '0.154.0' }]);
  const record = readProviderRecord(ledger, 'codex');
  assert.equal(record.installedVersion, '0.154.0');
  // 回退锚点仍停在最后一个**确证**可用的版本上。
  assert.equal(record.knownGoodVersion, '0.153.4');
});

test('基线本身就验证不过时拒绝升级', async () => {
  const { deps, calls } = makeDeps({ verify: async () => ({ verdict: VERDICTS.FAIL, detail: 'already broken' }) });
  const result = await runProviderUpgradeCycle('codex', emptyLedger(), deps);

  assert.equal(result.state, STATES.BASELINE_UNHEALTHY);
  assert.deepEqual(calls.plans, []);
});

// Windows 上 npm 去 unlink 运行中的 exe 必然 EPERM,这是常态不是故障。
test('EPERM 归为 lock_busy:推迟重试,不计熔断', async () => {
  const { deps } = makeDeps({
    runPlans: async () => ({ ok: false, stderr: "EPERM: operation not permitted, unlink 'C:\\...\\codex.exe'" })
  });
  const { ledger, result } = await runTwice(emptyLedger(), deps);

  assert.equal(result.reason, 'apply_failed_lock_busy');
  assert.equal(readProviderRecord(ledger, 'codex').consecutiveFailures, 0);
});

test('registry 不可达归为 network:不计熔断', async () => {
  const { deps } = makeDeps({ runPlans: async () => ({ ok: false, stderr: 'request to registry failed, reason getaddrinfo ENOTFOUND' }) });
  const { ledger, result } = await runTwice(emptyLedger(), deps);

  assert.equal(result.reason, 'apply_failed_network');
  assert.equal(readProviderRecord(ledger, 'codex').consecutiveFailures, 0);
});

test('版本不存在时拉黑该版本,不计熔断', async () => {
  const { deps } = makeDeps({ runPlans: async () => ({ ok: false, stderr: 'npm error code E404 - No matching version found' }) });
  const { ledger, result } = await runTwice(emptyLedger(), deps);

  assert.equal(result.reason, 'apply_failed_not_found');
  assert.ok(readProviderRecord(ledger, 'codex').blockedVersions.includes('0.154.0'));
});

test('不可钉版本的渠道一律不动手', async () => {
  const { deps, calls } = makeDeps({
    detectChannel: async () => ({ channel: CHANNELS.VENDOR_SELFUPDATE, pinnable: false, ownerPath: '', resolvedPath: '' })
  });
  const { result } = await runTwice(emptyLedger(), deps);

  assert.equal(result.reason, 'channel_not_pinnable');
  assert.deepEqual(calls.plans, []);
});

test('全局熔断后一切停摆', async () => {
  const { deps, calls } = makeDeps();
  const ledger = { ...emptyLedger(), global: { enabled: false, disabledReason: 'manual' } };
  const result = await runProviderUpgradeCycle('codex', ledger, deps);

  assert.equal(result.reason, 'global_disabled');
  assert.deepEqual(calls.plans, []);
});

test('检查失败不改状态、不计熔断', async () => {
  const { deps, calls } = makeDeps({ checkUpdate: async () => { throw new Error('offline'); } });
  const result = await runProviderUpgradeCycle('codex', emptyLedger(), deps);

  assert.equal(result.reason, 'check_failed');
  assert.deepEqual(calls.plans, []);
});

// 官方安装脚本会把 <BIN_DIR>/codex 覆盖成符号链接,而那正是 aih 的 CLI hook 垫片位置。
// 「版本升上去了但 aih 接管没了」是无声的半吊子状态,比升级失败更糟,必须回滚。
test('升级后 hook 装不回去 → 按验证失败处理并回滚', async () => {
  const { deps, calls } = makeDeps({
    detectChannel: async () => ({
      channel: CHANNELS.STANDALONE_RELEASE,
      pinnable: true,
      ownerPath: '/opt/codex/releases/0.153.4/bin/codex',
      resolvedPath: '/home/u/.local/bin/codex'
    }),
    runPlans: async (plans, context) => {
      calls.plans.push({ phase: context.phase, version: context.version, postInstall: plans[0].postInstall });
      return { ok: true };
    },
    reinstallCodexCliHook: async () => ({ ok: false, error: 'permission denied' })
  });
  const { ledger, result } = await runTwice(emptyLedger(), deps);

  // 升级 plan 带着善后标记，且升级后确实走了回滚。
  assert.deepEqual(calls.plans[0].postInstall, ['reinstall_codex_cli_hook']);
  assert.equal(calls.plans.length, 2);
  assert.equal(calls.plans[1].phase, 'rollback');
  // 回滚同样要补 hook，补不回来就是 broken。
  assert.equal(result.state, STATES.BROKEN);
  assert.equal(result.reason, 'rollback_post_install_failed');
  assert.equal(readProviderRecord(ledger, 'codex').enabled, false);
});

// 阶段一：只检查、不改动。闸门照常观测并记账（这正是阶段一要采集的数据），但绝不装任何东西，
// 且 consecutiveQuiescentTicks 必须归零——否则打开 apply 的那一刻会拿着攒了几天的计数立刻开装。
test('applyEnabled=false 时只检查不动手,且静默计数不累积', async () => {
  const { deps, calls } = makeDeps({
    checkQuiescence: async () => ({ busy: false, evidence: ['app_server:none'] })
  });
  const { ledger, result } = await runTwice(emptyLedger(), deps, { applyEnabled: false });

  assert.equal(result.state, STATES.HEALTHY);
  assert.equal(result.reason, 'apply_disabled');
  assert.equal(result.targetVersion, '0.154.0');
  assert.deepEqual(result.evidence, ['app_server:none']);
  assert.deepEqual(calls.plans, []);

  const record = readProviderRecord(ledger, 'codex');
  assert.equal(record.latestVersion, '0.154.0');
  assert.equal(record.installedVersion, '0.153.4');
  assert.equal(record.consecutiveQuiescentTicks, 0);
  assert.equal(record.lastDeferReason, 'apply_disabled');
});

test('applyEnabled=false 时忙闲照实记录', async () => {
  const { deps } = makeDeps({ checkQuiescence: async () => ({ busy: true, evidence: ['pty:aih-codex-1'] }) });
  const { ledger, result } = await runProviderUpgradeCycle('codex', emptyLedger(), deps, { applyEnabled: false })
    .then((r) => ({ ledger: r.ledger, result: r }));

  assert.equal(result.reason, 'apply_disabled');
  assert.equal(result.busy, true);
  assert.equal(readProviderRecord(ledger, 'codex').lastDeferReason, 'busy');
});

test('hook 能装回去时升级正常通过', async () => {
  let hookCalls = 0;
  const { deps } = makeDeps({
    detectChannel: async () => ({
      channel: CHANNELS.STANDALONE_RELEASE,
      pinnable: true,
      ownerPath: '/opt/codex/releases/0.153.4/bin/codex',
      resolvedPath: '/home/u/.local/bin/codex'
    }),
    reinstallCodexCliHook: async () => { hookCalls += 1; return { ok: true }; }
  });
  const { result } = await runTwice(emptyLedger(), deps);

  assert.equal(result.reason, 'verified_pass');
  assert.equal(hookCalls, 1);
});
