'use strict';

// 额度统计维度的选择策略：**provider + 账号类型 → 支持的泛范围**，再由账号证据收窄。
//
// 三层，从确定到不确定：
//   1. 账号证据（样本 ∪ 重置事件 ∪ 当前快照）—— 确定：这个账号真有这些窗口；
//   2. provider 声明（descriptor.quota.stats.windows）—— 不确定时问它：
//      「这个 Provider 最多能产出哪些窗口长度」；
//   3. 都没有 —— 没有窗口维度，页面走日/周统计，而不是给一张空窗口图。
//
// 为什么不在共享代码里写死 5h/7天/30天：各 Provider 的窗口本来就不同
// （zcode 是 1天/7天/30天，claude 只有 5h/7天，积分型 Provider 一个窗口都没有），
// 写死会让页面显示账号根本不可能有的维度，也会把「没有数据」伪装成「有维度但空」。
//
// 为什么声明不等于事实：同一个 Provider 的不同套餐窗口不同（部分 Plus 没有 5h），
// 所以声明只当**泛范围**用，账号自己的快照永远优先。

const { getProviderCapability } = require('../providers');

function normalizeMinutes(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes <= 0) return 0;
  return minutes;
}

function uniqueSortedMinutes(values) {
  const set = new Set();
  for (const value of values || []) {
    const minutes = normalizeMinutes(value);
    if (minutes) set.add(minutes);
  }
  return [...set].sort((left, right) => left - right);
}

/**
 * provider 声明的窗口泛范围（分钟）。未声明 / 未知 provider 返回空数组。
 * 读的是描述符的 quota.stats.windows，因此新增 Provider 只改它自己的 defs 文件。
 */
function getDeclaredQuotaWindows(provider, options = {}) {
  const quota = getProviderCapability(provider, 'quota', options);
  const stats = quota && quota.stats;
  return uniqueSortedMinutes(stats && stats.windows);
}

/**
 * 决定统计页要用哪些窗口维度。
 *
 * @param {object} input
 * @param {string} input.provider   provider id
 * @param {number[]} [input.observedWindows] 样本/重置事件里出现过的窗口长度
 * @param {number[]} [input.snapshotWindows] 当前快照里出现过的窗口长度
 * @returns {{windows: number[], source: 'account'|'provider'|'none'}}
 *   source 说明这批维度是哪来的：account = 账号证据、provider = 声明泛范围、none = 没有。
 */
function resolveQuotaStatsWindows({ provider, observedWindows = [], snapshotWindows = [], options = {} } = {}) {
  const evidence = uniqueSortedMinutes([...(observedWindows || []), ...(snapshotWindows || [])]);
  if (evidence.length > 0) return { windows: evidence, source: 'account' };

  const declared = getDeclaredQuotaWindows(provider, options);
  if (declared.length > 0) return { windows: declared, source: 'provider' };

  return { windows: [], source: 'none' };
}

module.exports = {
  getDeclaredQuotaWindows,
  resolveQuotaStatsWindows
};
