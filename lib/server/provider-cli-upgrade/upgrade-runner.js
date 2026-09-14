'use strict';

// 单个 provider 的升级闭环：检查 → 闸门 → 升级 → 验证 → 回滚 → 记账。
//
// 全部依赖注入，本模块不 require 定时器、不发起网络、不直接 spawn，
// 因此整条状态机（含回滚与熔断）可以在不真装包的前提下被完整测试。
//
// 两条贯穿始终的原则：
//   1. 只在拿到**正向失败信号**时回滚。验证「没拿到成功信号」不等于「失败」——
//      超时/探针自身出错一律按 inconclusive 处理，放行但**不推进 knownGood**，
//      于是下一次真正的失败仍有一个可靠的回退目标。宁可少回滚，不可回滚到坏基线。
//   2. 回滚失败是终局。此时机器停在已知坏版本上，绝不静默重试——立刻熔断并高声上报，
//      因为再装一次极可能只是把同一个坏版本再装一遍。

const { DECISIONS, decide } = require('./upgrade-policy');
const { buildPinnedPlans } = require('./upgrade-plan-builder');
const { classifyInstallFailure } = require('./upgrade-error-classifier');
const { isQuiescentEnough } = require('./upgrade-liveness');
const { readProviderRecord, writeProviderRecord, appendHistory } = require('./upgrade-ledger');

const STATES = Object.freeze({
  HEALTHY: 'healthy',
  BASELINE_UNHEALTHY: 'baseline_unhealthy',
  DEFERRED: 'deferred',
  ROLLED_BACK: 'rolled_back',
  BROKEN: 'broken'
});

const VERDICTS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  INCONCLUSIVE: 'inconclusive'
});

const MAX_CONSECUTIVE_FAILURES = 2;

function outcome(state, reason, extra = {}) {
  return { ok: true, state, reason, ...extra };
}

/**
 * 跑一个 provider 的一轮闭环。永不抛。
 *
 * deps:
 *   now()                            -> number
 *   checkUpdate(provider)            -> {installedVersion, latestVersion, publishedAt}
 *   detectChannel(provider)          -> {channel, pinnable, ownerPath, resolvedPath, shadowedNpmInstall}
 *   checkQuiescence(provider)        -> {busy, evidence}
 *   runPlans(plans, context)         -> {ok, error, stderr, stdout}
 *   verify(provider, expectedVersion)-> {verdict, detail}
 *   log(entry)                       -> void
 */
async function runProviderUpgradeCycle(provider, ledger, deps = {}, config = {}) {
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const record = readProviderRecord(ledger, provider);
  const commit = (patch) => writeProviderRecord(ledger, provider, patch);
  const emit = (entry) => { if (typeof deps.log === 'function') deps.log({ provider, at: now, ...entry }); };

  if (ledger.global && ledger.global.enabled === false) {
    return { ledger, ...outcome(record.state, 'global_disabled') };
  }
  if (record.state === STATES.BROKEN) {
    // 熔断是终局状态，只能人工清除，绝不自愈式重试。
    return { ledger, ...outcome(STATES.BROKEN, 'provider_broken') };
  }

  let channel;
  try {
    channel = await deps.detectChannel(provider);
  } catch (error) {
    return { ledger: commit({ lastCheckError: String(error && error.message || error) }), ...outcome(record.state, 'channel_detect_failed') };
  }

  let update;
  try {
    update = await deps.checkUpdate(provider);
  } catch (error) {
    // 网络类检查失败不改状态、不计熔断，只记错误。
    return {
      ledger: commit({ lastCheckAt: now, lastCheckError: String(error && error.message || error) }),
      ...outcome(record.state, 'check_failed')
    };
  }

  const installedVersion = String(update.installedVersion || '');
  const base = {
    lastCheckAt: now,
    lastCheckError: '',
    channel: channel.channel,
    ownerPath: channel.ownerPath || '',
    resolvedPath: channel.resolvedPath || '',
    shadowedNpmInstall: Boolean(channel.shadowedNpmInstall),
    installedVersion,
    latestVersion: String(update.latestVersion || '')
  };

  // 基线验证：任何 apply 之前必须存在一个已验证、且回得去的目标。
  // 分不清「是我们升坏的」还是「它本来就坏」时，正确动作是不动手。
  let baselineHealthy = record.baselineHealthy;
  let knownGoodVersion = record.knownGoodVersion;
  let knownGoodRollbackable = record.knownGoodRollbackable;
  if (!knownGoodVersion && installedVersion) {
    const baseline = await deps.verify(provider, installedVersion);
    baselineHealthy = baseline.verdict !== VERDICTS.FAIL;
    if (baselineHealthy) {
      knownGoodVersion = installedVersion;
      knownGoodRollbackable = Boolean(channel.pinnable);
    } else {
      emit({ event: 'baseline_unhealthy', detail: baseline.detail || '' });
      return {
        ledger: commit({ ...base, baselineHealthy: false, state: STATES.BASELINE_UNHEALTHY }),
        ...outcome(STATES.BASELINE_UNHEALTHY, 'baseline_unhealthy')
      };
    }
  }

  const decision = decide({
    now,
    enabled: record.enabled,
    pinnable: channel.pinnable,
    userPin: record.userPin,
    baselineHealthy,
    knownGoodRollbackable,
    installedVersion,
    latestVersion: update.latestVersion,
    publishedAt: update.publishedAt,
    blockedVersions: record.blockedVersions,
    soakUnknownCount: record.soakUnknownCount
  }, config);

  const carry = { ...base, baselineHealthy, knownGoodVersion, knownGoodRollbackable };
  if (decision.decision !== DECISIONS.UPGRADE) {
    const soakUnknownCount = decision.reason === 'soak_pending_unknown_publish_time'
      ? Number(record.soakUnknownCount || 0) + 1
      : record.soakUnknownCount;
    return {
      ledger: commit({ ...carry, state: STATES.HEALTHY, targetVersion: decision.targetVersion || '', soakUnknownCount }),
      ...outcome(STATES.HEALTHY, decision.reason)
    };
  }

  // 静默闸门：连续两次观测到闲才动手。忙不计熔断，只推迟。
  const quiescence = await deps.checkQuiescence(provider);
  const quiescentTicks = quiescence.busy ? 0 : Number(record.consecutiveQuiescentTicks || 0) + 1;
  if (quiescence.busy || !isQuiescentEnough(quiescentTicks)) {
    return {
      ledger: commit({
        ...carry,
        state: STATES.DEFERRED,
        targetVersion: decision.targetVersion,
        consecutiveQuiescentTicks: quiescentTicks,
        consecutiveDefers: Number(record.consecutiveDefers || 0) + 1,
        lastDeferReason: quiescence.busy ? 'busy' : 'awaiting_quiescence'
      }),
      ...outcome(STATES.DEFERRED, quiescence.busy ? 'deferred_busy' : 'awaiting_quiescence', { evidence: quiescence.evidence })
    };
  }

  const target = decision.targetVersion;
  const planResult = buildPinnedPlans({
    channel: channel.channel,
    packageName: channel.packageName || update.packageName || '',
    version: target,
    platform: config.platform,
    installDir: channel.installDir || '',
    env: config.env
  });
  if (!planResult.ok) {
    return {
      ledger: commit({ ...carry, state: STATES.HEALTHY, lastApplyError: planResult.reason }),
      ...outcome(STATES.HEALTHY, planResult.reason)
    };
  }

  emit({ event: 'apply_start', from: installedVersion, to: target });
  const applied = await deps.runPlans(planResult.plans, { provider, version: target, phase: 'upgrade' });
  if (!applied.ok) {
    const failure = classifyInstallFailure(applied);
    const failures = failure.countsTowardBreaker ? Number(record.consecutiveFailures || 0) + 1 : record.consecutiveFailures;
    const blocked = failure.category === 'not_found'
      ? Array.from(new Set([...record.blockedVersions, target]))
      : record.blockedVersions;
    emit({ event: 'apply_failed', to: target, category: failure.category });
    return {
      ledger: commit({
        ...carry,
        state: failure.countsTowardBreaker ? STATES.HEALTHY : STATES.DEFERRED,
        targetVersion: target,
        lastApplyAt: now,
        lastApplyError: failure.category,
        blockedVersions: blocked,
        consecutiveFailures: failures,
        consecutiveQuiescentTicks: 0
      }),
      ...outcome(failure.countsTowardBreaker ? STATES.HEALTHY : STATES.DEFERRED, `apply_failed_${failure.category}`)
    };
  }

  const verdict = await deps.verify(provider, target);
  if (verdict.verdict !== VERDICTS.FAIL) {
    // inconclusive 放行，但 knownGood 不前进——保住一个确定可靠的回退目标。
    const advanced = verdict.verdict === VERDICTS.PASS;
    emit({ event: 'apply_verified', to: target, verdict: verdict.verdict });
    return {
      ledger: commit({
        ...carry,
        state: STATES.HEALTHY,
        installedVersion: target,
        targetVersion: '',
        knownGoodVersion: advanced ? target : knownGoodVersion,
        knownGoodRollbackable: advanced ? Boolean(channel.pinnable) : knownGoodRollbackable,
        lastApplyAt: now,
        lastApplyError: '',
        consecutiveFailures: 0,
        consecutiveQuiescentTicks: 0,
        history: appendHistory(record, { at: now, from: installedVersion, to: target, outcome: verdict.verdict })
      }),
      ...outcome(STATES.HEALTHY, `verified_${verdict.verdict}`)
    };
  }

  // 拿到正向失败信号 → 回滚。
  emit({ event: 'verify_failed', to: target, detail: verdict.detail || '' });
  const blockedVersions = Array.from(new Set([...record.blockedVersions, target]));
  const rollbackPlans = buildPinnedPlans({
    channel: channel.channel,
    packageName: channel.packageName || update.packageName || '',
    version: knownGoodVersion,
    platform: config.platform,
    installDir: channel.installDir || '',
    env: config.env
  });

  const broken = (reason, detail) => {
    emit({ event: 'broken', to: target, reason, detail });
    return {
      ledger: writeProviderRecord(
        { ...ledger, global: { ...(ledger.global || {}), enabled: ledger.global && ledger.global.enabled } },
        provider,
        {
          ...carry,
          state: STATES.BROKEN,
          enabled: false,
          disabledReason: reason,
          targetVersion: target,
          installedVersion: target,
          blockedVersions,
          lastApplyAt: now,
          lastApplyError: reason,
          consecutiveFailures: Number(record.consecutiveFailures || 0) + 1,
          history: appendHistory(record, { at: now, from: installedVersion, to: target, outcome: 'broken', detail: reason })
        }
      ),
      ...outcome(STATES.BROKEN, reason)
    };
  };

  if (!rollbackPlans.ok) return broken('rollback_plan_unavailable', rollbackPlans.reason);

  const rolled = await deps.runPlans(rollbackPlans.plans, { provider, version: knownGoodVersion, phase: 'rollback' });
  if (!rolled.ok) return broken('rollback_install_failed', classifyInstallFailure(rolled).category);

  // 回滚后必须再验证一次：没验证过的回滚只是又一次没根据的安装。
  const rolledVerdict = await deps.verify(provider, knownGoodVersion);
  if (rolledVerdict.verdict === VERDICTS.FAIL) return broken('rollback_verify_failed', rolledVerdict.detail || '');

  emit({ event: 'rolled_back', from: target, to: knownGoodVersion });
  return {
    ledger: commit({
      ...carry,
      state: STATES.ROLLED_BACK,
      installedVersion: knownGoodVersion,
      targetVersion: '',
      blockedVersions,
      lastApplyAt: now,
      lastApplyError: 'verify_failed',
      consecutiveFailures: Number(record.consecutiveFailures || 0) + 1,
      consecutiveQuiescentTicks: 0,
      history: appendHistory(record, { at: now, from: installedVersion, to: target, outcome: 'rolled_back', detail: verdict.detail || '' })
    }),
    ...outcome(STATES.ROLLED_BACK, 'rolled_back')
  };
}

module.exports = { STATES, VERDICTS, MAX_CONSECUTIVE_FAILURES, runProviderUpgradeCycle };
