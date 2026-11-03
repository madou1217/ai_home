'use strict';

// 判断某个 provider 现在有没有在跑的进程。这是「绝不打断在跑会话」的闸门，
// 同时也是 Windows EPERM 的规避手段（npm 会 unlink 正在运行的 exe，忙就不升最省事）。
//
// 判据刻意偏向「误判为忙」：误判忙只是推迟一轮升级，误判闲会打断用户正在进行的对话。
//
// 信号来自 aih 自己落盘的运行时状态，不去扫全系统进程表：
//   run/codex-app-server/*.json —— 常驻 app-server（带 pid，可校验存活）
//   run/persistent-sessions/aih-<provider>-*.json —— PTY 常驻会话
// 这两处是 aih 自己写的事实，比解析 ps 输出稳，也不必每轮都付一次进程枚举的代价。

const nodeFs = require('node:fs');

const { resolveAihRunPath } = require('../../runtime/aih-storage-layout');
const { getProviderUpgradePlugin } = require('./provider-plugins');
const { listJsonFiles } = require('./provider-plugins/run-state');

// provider 私有的「在跑」证据（如 codex 的常驻 app-server）由它的升级插件提供。
function collectPluginEvidence(provider, options) {
  const plugin = getProviderUpgradePlugin(provider);
  return typeof plugin?.collectBusyEvidence === 'function' ? plugin.collectBusyEvidence(options) : [];
}

function collectPersistentSessionEvidence(provider, options) {
  const fsImpl = options.fs || nodeFs;
  const dir = resolveAihRunPath(options.aiHomeDir, 'persistent-sessions');
  if (!dir) return [];
  const prefix = `aih-${provider}-`;
  return listJsonFiles(fsImpl, dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => `session:${name.replace(/\.json$/, '')}`);
}

/**
 * @returns {{busy: boolean, evidence: string[], observedAt: number}}
 */
function checkProviderQuiescence(provider, options = {}) {
  const normalized = String(provider || '').trim().toLowerCase();
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  if (!normalized) return { busy: true, evidence: ['provider_unknown'], observedAt: now };

  const evidence = [
    ...collectPluginEvidence(normalized, options),
    ...collectPersistentSessionEvidence(normalized, options)
  ];
  return { busy: evidence.length > 0, evidence, observedAt: now };
}

// 连续两次观测到静默才允许动手。用「连续次数」而不是 wall-clock 空闲时长：
// apply 周期本身就有十几分钟，上一次观测几乎总是过期，按时长判定等于闸门形同虚设。
const REQUIRED_QUIESCENT_TICKS = 2;

function isQuiescentEnough(consecutiveQuiescentTicks) {
  return Number(consecutiveQuiescentTicks || 0) >= REQUIRED_QUIESCENT_TICKS;
}

module.exports = {
  REQUIRED_QUIESCENT_TICKS,
  checkProviderQuiescence,
  isQuiescentEnough
};
