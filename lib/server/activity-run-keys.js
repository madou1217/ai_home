'use strict';

// 账号活动（签到 / 领臭鸡蛋）的运行键命名，**唯一构造点**。
//
// 为什么单独一个模块：领取与探测是两套键空间（探测不能吃掉领取的防抖窗口），
// 但它们打的是同一个上游端点，**不能同时进行**。2026-10-31 实测：同一批账号并发
// GET billing/preview，4 个请求里 3 个 429；改成串行全部 200。所以「探测在跑时
// 不领、领取在跑时不探」这条互斥必须两边用同一套键，否则一边写 `probe:activity:`
// 另一边写 `activity:probe:` 就互不相识 —— 键名只在这里拼。

const { isRunning, listRunningKeys } = require('./scheduled-run-guard');

/** 领取键（不含参数指纹；指纹由 runKey 追加）。 */
function activityClaimKey(provider, actionId) {
  return `activity:${provider}:${actionId}`;
}

/** 探测键：与领取**分键空间**，只用于互斥与探测自己的短防抖窗口。 */
function activityProbeKey(provider, actionId) {
  return `probe:activity:${provider}:${actionId}`;
}

/** 计划任务的事件 id 形如 `activity:<provider>:<actionId>`；不是活动事件时返回 null。 */
function parseActivityEventId(eventId) {
  const parts = String(eventId || '').trim().split(':');
  if (parts.length !== 3 || parts[0] !== 'activity') return null;
  const provider = parts[1].trim();
  const actionId = parts[2].trim();
  if (!provider || !actionId) return null;
  return { provider, actionId };
}

/** 该 provider 的这个动作是否正在被探测（探测只读，但一样在打上游）。 */
function isActivityProbeRunning(provider, actionId) {
  const key = activityProbeKey(provider, actionId);
  return Boolean(key) && isRunning(key);
}

/**
 * 该 provider 的这个动作是否有领取在跑。
 *
 * 不能只查裸键：领取键会带参数指纹（`#…`），多 provider 批量还会用 `+` 连接，
 * 于是「按参数领 acct_b」在跑的键是 `activity:zcode:trial_plan#{"accountRefs":["acct_b"]}`。
 * 这里按「+ 拆分、去掉 # 指纹」后逐个比对，才能覆盖全部形态。
 */
function isActivityClaimRunning(provider, actionId) {
  const wanted = activityClaimKey(provider, actionId);
  return listRunningKeys().some((key) => (
    String(key).split('+').some((part) => part.split('#')[0] === wanted)
  ));
}

/** 计划任务事件是否撞上正在执行的探测。 */
function isActivityEventProbed(eventId) {
  const parsed = parseActivityEventId(eventId);
  return parsed ? isActivityProbeRunning(parsed.provider, parsed.actionId) : false;
}

module.exports = {
  activityClaimKey,
  activityProbeKey,
  parseActivityEventId,
  isActivityClaimRunning,
  isActivityProbeRunning,
  isActivityEventProbed
};
