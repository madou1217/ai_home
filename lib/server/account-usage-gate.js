'use strict';

// 选号阶段的额度门禁（与 provider 无关：所有推理路径的选号都经过 account-selector）。
//
// 规则：账号剩余额度低到后台「自动切换阈值」换算出的下限（含用完）时不参与调度，直到异步
// 用量刷新写入的新快照显示额度回到下限以上才重新可用。人工「启用」只改生命周期状态，不绕过
// 额度事实。下限 = 100 − threshold_pct（usage 配置，默认 95 → 剩余 ≤ 5% 停用），与 codex
// 一直以来的「阈值停池」同一换算（resolveMinimumRemainingPct）。
//
// 为什么在选号时判、而不是只在加载池时判（2026-10-31 kiro 事故）：池只在重建时读快照，kiro
// 等 loader 根本不读，账号对象上的 remainingPct 恒为 null —— 用完的账号被人工启用后，选号器
// 看不到「额度为 0」，每个请求都打过去吃上游 400 ServiceQuotaExceededException。这里直接读
// 用量快照存储（每次探测都会写），按 provider 额度声明的作用域求值（账号级 entries / 按模型
// models，经 provider-usage-policy 的同一套策略），按模型计额度的 provider 不会因为一个模型
// 用完就整号停用。
//
// 快照缺失或不可信 = 额度未知，不拦（未知 ≠ 耗尽，与模型目录「未知 ≠ 不支持」同一口径）。
//
// 上游亲口说「额度用完」时（统一失败门禁 observeFailure 观察到额度类失败），立即为该账号排一次
// 强制用量刷新：快照随之变成 0，门禁从下一次选号起就拦住它，不必等定时刷新。

const ALLOW = Object.freeze({ schedulable: true, status: 'schedulable', reason: '' });

// 读快照存储与阈值配置的缓存期：选号是热路径，每次都开库读太贵（实测单次 ~0.8ms）；
// 探测本身 ≥45s 一次，几秒的延迟不影响结论。
const SNAPSHOT_READER_TTL_MS = 5000;
const THRESHOLD_TTL_MS = 5000;
// 同一账号的「额度失败 → 强制刷新」最短间隔：一阵并发失败只排一次探测。
const QUOTA_FAILURE_REFRESH_DEBOUNCE_MS = 30000;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function readCapturedAt(snapshot) {
  const value = Number(snapshot && snapshot.capturedAt);
  return Number.isFinite(value) ? value : 0;
}

function createAccountUsageGate(deps = {}) {
  // 依赖在工厂内加载：门禁只在 server 装配时创建，选号模块只引用下面那两个轻量入口，
  // 避免 account-selector 在加载期牵进额度注册表 / provider 描述符整条依赖链。
  const { loadAccountUsageSnapshotReader } = require('../account/usage-snapshot-store');
  const { resolveMinimumRemainingPct } = require('../account/derived-state');
  const { readUsageThresholdPct } = require('../usage/config-store');
  const { isTrustedQuotaSnapshot } = require('../usage/quota');
  const { USAGE_STATUSES, evaluateProviderModelUsage } = require('./provider-usage-policy');

  const { fs, aiHomeDir } = deps;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const loadSnapshotReader = typeof deps.loadSnapshotReader === 'function'
    ? deps.loadSnapshotReader
    : () => loadAccountUsageSnapshotReader(fs, aiHomeDir);
  const readThresholdPct = typeof deps.readThresholdPct === 'function'
    ? deps.readThresholdPct
    : () => readUsageThresholdPct({ fs, aiHomeDir });
  const refreshUsage = typeof deps.refreshUsage === 'function' ? deps.refreshUsage : null;
  const usagePolicyRegistry = deps.usagePolicyRegistry || null;

  let reader = null;
  let readerLoadedAt = -Infinity;
  let minimumRemainingPct = null;
  let thresholdLoadedAt = -Infinity;
  const lastRefreshAt = new Map();

  function readStoredSnapshot(accountRef) {
    const at = now();
    if (at - readerLoadedAt >= SNAPSHOT_READER_TTL_MS) {
      try {
        reader = loadSnapshotReader();
      } catch (_error) {
        reader = null;
      }
      readerLoadedAt = at;
    }
    if (typeof reader !== 'function') return null;
    try {
      return reader(accountRef) || null;
    } catch (_error) {
      return null;
    }
  }

  function readMinimumRemainingPct() {
    const at = now();
    if (at - thresholdLoadedAt >= THRESHOLD_TTL_MS) {
      try {
        minimumRemainingPct = resolveMinimumRemainingPct(readThresholdPct());
      } catch (_error) {
        minimumRemainingPct = null;
      }
      thresholdLoadedAt = at;
    }
    return minimumRemainingPct;
  }

  // 存储里的快照（每次探测都写）与账号对象上的快照（加载池时读入）取采集时间更新的那份。
  function resolveSnapshot(account, provider) {
    const accountRef = normalizeText(account.accountRef);
    const candidates = [accountRef ? readStoredSnapshot(accountRef) : null, account.usageSnapshot]
      .filter((snapshot) => snapshot && isTrustedQuotaSnapshot(provider, snapshot));
    if (candidates.length === 0) return null;
    return candidates.sort((left, right) => readCapturedAt(right) - readCapturedAt(left))[0];
  }

  function block(status, reason, decision, minimum) {
    return {
      schedulable: false,
      status,
      reason,
      remainingPct: decision.remainingPct,
      minimumRemainingPct: minimum,
      resetAtMs: decision.resetAtMs || 0
    };
  }

  /**
   * (账号, 模型) 现在按额度能不能被调度。
   * @returns {{schedulable: boolean, status: string, reason: string, remainingPct?: number,
   *   minimumRemainingPct?: number|null, resetAtMs?: number}}
   */
  function evaluate(account, model = '') {
    if (!account || typeof account !== 'object' || account.apiKeyMode) return ALLOW;
    const provider = normalizeText(account.provider).toLowerCase();
    if (!provider) return ALLOW;
    const snapshot = resolveSnapshot(account, provider);
    if (!snapshot) return ALLOW;
    // 只信快照：账号对象上的 remainingPct 可能是加载池时的旧值。
    const decision = evaluateProviderModelUsage(provider, {
      accountRef: account.accountRef,
      apiKeyMode: false,
      remainingPct: null,
      usageSnapshot: snapshot
    }, normalizeText(model), usagePolicyRegistry);
    const minimum = readMinimumRemainingPct();
    if (decision.status === USAGE_STATUSES.EXHAUSTED) {
      return block('blocked_by_quota', 'usage_exhausted', decision, minimum);
    }
    if (decision.status === USAGE_STATUSES.AVAILABLE
      && Number.isFinite(decision.remainingPct)
      && Number.isFinite(minimum)
      && decision.remainingPct <= minimum) {
      return block('blocked_by_policy', 'usage_below_server_threshold', decision, minimum);
    }
    return ALLOW;
  }

  /** 上游说额度用完了：为该账号排一次强制用量刷新（去抖），刷新完成后立刻重读快照。 */
  function refreshAfterQuotaFailure(provider, account) {
    if (!refreshUsage || !account || account.apiKeyMode) return false;
    const accountRef = normalizeText(account.accountRef);
    const normalizedProvider = normalizeText(provider || account.provider).toLowerCase();
    if (!accountRef || !normalizedProvider) return false;
    const at = now();
    if (at - (lastRefreshAt.get(accountRef) || -Infinity) < QUOTA_FAILURE_REFRESH_DEBOUNCE_MS) return false;
    lastRefreshAt.set(accountRef, at);
    Promise.resolve()
      .then(() => refreshUsage(normalizedProvider, accountRef, readStoredSnapshot(accountRef)))
      .catch(() => null)
      .then(() => { readerLoadedAt = -Infinity; });
    return true;
  }

  return { evaluate, refreshAfterQuotaFailure };
}

// 进程内唯一的门禁实例由 server 装配（installAccountUsageGate）。没装配时（CLI、单测）一律放行，
// 行为与引入门禁之前完全一致。
let installedGate = null;

function installAccountUsageGate(gate) {
  installedGate = gate && typeof gate.evaluate === 'function' ? gate : null;
  return installedGate;
}

function evaluateAccountUsageGate(account, model = '') {
  if (!installedGate) return ALLOW;
  try {
    return installedGate.evaluate(account, model) || ALLOW;
  } catch (_error) {
    return ALLOW; // 门禁自身异常按「不拦」处理：宁可发出去，也不要凭空摘账号
  }
}

module.exports = {
  createAccountUsageGate,
  evaluateAccountUsageGate,
  installAccountUsageGate,
  __private: {
    QUOTA_FAILURE_REFRESH_DEBOUNCE_MS,
    SNAPSHOT_READER_TTL_MS,
    THRESHOLD_TTL_MS
  }
};
