'use strict';

// 账号活动的**统一限流口径**：批量领取时账号之间的最小间隔。
//
// 上游（2026-11-06 真机）在连续请求下会回 HTTP 429；WebUI 任务队列、计划任务、
// 命令行 claim 必须用同一个值，否则「页面里慢慢领没事、命令行连点就 429」。
// 429 的退避重试在 zcode-plan 里单独实现；这里只解决并发/连点。
const ACCOUNT_ACTIVITY_PACING_MS = 1_500;

module.exports = {
  ACCOUNT_ACTIVITY_PACING_MS
};
