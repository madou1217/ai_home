'use strict';

// 启动时间线：从进程启动到网关开始监听，每一段各花了多少时间。
//
// 为什么是完整时间线而不是"只报超阈值的步骤"：线上实测一次重启从进程启动到端口可用约 11s，
// 已知各段合计只有约 1s。这类缺口往往是很多小步骤累加出来的，阈值过滤会把它们全部漏掉；
// 而进程在进入 startLocalServer 之前（加载模块、额度状态刷新）花的时间，在 server 内部根本看不到，
// 所以必须同时给出进程运行时长。监听之前的每一毫秒都是网关的停机时间。

function normalizeSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .filter((step) => step && typeof step.name === 'string' && Number.isFinite(Number(step.ms)))
    .map((step) => ({ name: step.name, ms: Math.max(0, Math.round(Number(step.ms))) }));
}

function formatSteps(steps) {
  return steps.map((step) => `${step.name} ${step.ms}ms`).join(', ');
}

/**
 * 计时一段同步工作并把结果追加到 steps（供进入 server 之前的调用方使用）。
 */
function timeStep(steps, name, fn, now = Date.now) {
  const startedAt = now();
  try {
    return fn();
  } finally {
    steps.push({ name, ms: now() - startedAt });
  }
}

function createStartupTimeline(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const uptimeMs = typeof options.uptimeMs === 'function'
    ? options.uptimeMs
    : () => process.uptime() * 1000;
  const preludeSteps = normalizeSteps(options.preludeSteps);
  const enteredAt = now();
  const enteredAtUptimeMs = Math.round(uptimeMs());
  const steps = [];
  let lastMarkAt = enteredAt;

  // mark 记录"上一个标记到现在"这一段：调用方只需在每段结束处打点，不必成对包裹代码。
  function mark(name) {
    const at = now();
    steps.push({ name, ms: at - lastMarkAt });
    lastMarkAt = at;
  }

  function format() {
    const insideMs = now() - enteredAt;
    // 进入 server 之前、又不属于任何前置步骤的部分 = 加载模块 + CLI 顶层装配（打开状态库等）。
    // 单独列出来，缺口落在"server 之外"时才能一眼看出来。
    const preludeMs = preludeSteps.reduce((sum, step) => sum + step.ms, 0);
    const beforeSteps = [{ name: 'load+compose', ms: Math.max(0, enteredAtUptimeMs - preludeMs) }, ...preludeSteps];
    const parts = [
      `listening after ${Math.round(uptimeMs())}ms since process start`,
      `before server ${enteredAtUptimeMs}ms (${formatSteps(beforeSteps)})`,
      `inside server ${insideMs}ms${steps.length ? ` (${formatSteps(steps)})` : ''}`
    ];
    return parts.join(' | ');
  }

  return {
    mark,
    format,
    steps: () => steps.slice(),
    preludeSteps: () => preludeSteps.slice()
  };
}

module.exports = {
  createStartupTimeline,
  timeStep
};
