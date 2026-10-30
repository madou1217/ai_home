'use strict';

// 账号 in-use 捕获（持久 CLI 会话来源）—— accountActivity 的第三条活跃来源。
//
// 为什么需要它：另两条来源各有一半盲区。
//   * 网关 attempt（begin/end）只在请求经过 aih 时计数；
//   * provider hook（markSessionTurn）只覆盖合同声明 sessionSync.mode='hook' 的
//     provider（codex / claude / gemini / agy / opencode / grok）。
// 其余 harness 没有 hook 事件，回合活性只能靠观测。
//
// 本模块是**编排者**，不认识任何 provider / harness 名字。判定粒度是 harness
// （CLI/Agent 本体，不是 provider 账号）：codex 走 relay 时账号是别的 provider 的，
// 但「codex 正在跑回合」属于 codex；pi/dsh 这类外部 harness 也能用任意账号。
// 每个 harness 怎么观测，由 lib/harness/activity/probes/ 下的探测策略声明，
// 注册表（lib/harness/activity）按目录自动装载——**新增 harness 只加一个探测模块，
// 本文件的入口、server 的接线都不改**。
//
// 两个层次严格分开：
//
//   1) 「终端开着」= markRuntime：只用于展示（几个会话、几个在用），**不点亮转圈**。
//      用户只是 `aih <provider> <id>` 打开了一个空 CLI，不代表账号在服务。
//   2) 「正在跑回合」= markSessionTurn：由探测策略给出的回合信号决定。多个信号按
//      「明确结束（decisive）> 有活动 > 权威空闲 > 不动」组合；冲突时时间较新的信号优先。
//      没有官方 hook 的 harness 由 pane 活动（tmux window_activity）兜底；有原生会话
//      清单的开源 harness（cline/kiro）用自己的 started_at/ended_at/usage_summary 判定。
//  合同声明 sessionSync.mode='hook' 的 provider 只接受「有输出 → 一定在跑」这一个方向，
//  熄灯仍由权威 hook 事件负责（pane 信号标记为 positive，不参与熄灯）。
//
// 停用账号（配置层 status=down）一律跳过：终端还开着也不能显示「运行中」。
//
// 与 hook 回合一致，用「标记 + TTL」而不是 begin/end 计数：轮询进程被杀、tmux 暂时
// 不可用（超时/忙）都只会让标记自然过期，不会永久泄漏成「一直在转圈」。

const path = require('path');
const { listAccountRefRecords } = require('./account-ref-store');
const persistentSessionRegistry = require('../runtime/persistent-session-registry');
const { listHarnessActivityProbes } = require('../harness/activity');
const {
  detectPersistentTmux,
  listPersistentSessionsForAccount
} = require('./persistent-session-runtime');

const DEFAULT_POLL_INTERVAL_MS = 5_000;
// TTL 至少覆盖两个轮询周期：单次探测失败（tmux 忙 / 超时）不该立刻熄灯。
const MIN_RUNTIME_TTL_MS = 12_000;
// 账号范围缓存：account_refs 是全量候选，注册表才是「真的有会话」的窄集合。
const SCOPES_CACHE_MS = 30_000;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeProvider(value) {
  return normalizeText(value).toLowerCase();
}

function createAccountSessionActivityPoller(options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const pathImpl = options.path || path;
  const aiHomeDir = normalizeText(options.aiHomeDir);
  // 宿主共享会话库（~/.cline、~/.kiro）的根：探测策略自己决定要不要读。
  const hostHomeDir = normalizeText(options.hostHomeDir);
  const accountActivity = options.accountActivity || null;
  const intervalMs = Math.max(1000, Number(options.intervalMs) || DEFAULT_POLL_INTERVAL_MS);
  const ttlMs = Math.max(
    MIN_RUNTIME_TTL_MS,
    Number(options.ttlMs) || intervalMs * 3
  );

  const listAccountRefs = typeof options.listAccountRefs === 'function'
    ? options.listAccountRefs
    : () => listAccountRefRecords(fsImpl, aiHomeDir, '', { bestEffort: true });
  // 探测目标 = 「注册表里有会话的账号」（每个持久启动都会写一条），而不是全部账号：
  // 全量账号 × 每轮一次 tmux 探测会把事件循环按秒级阻塞。注册表读取是纯文件读，
  // 无进程开销；account_refs 只作为注册表条目缺 accountRef 时的补充来源。
  const listRegistryEntries = typeof options.listRegistryEntries === 'function'
    ? options.listRegistryEntries
    : () => {
        if (!aiHomeDir) return [];
        try {
          return persistentSessionRegistry.listEntries(aiHomeDir, { fs: fsImpl });
        } catch (_error) {
          return [];
        }
      };
  const detectTmux = typeof options.detectTmux === 'function'
    ? options.detectTmux
    : () => detectPersistentTmux({ ...options, fs: fsImpl });
  const listSessions = typeof options.listSessions === 'function'
    ? options.listSessions
    : (provider, accountRef, tmux) => listPersistentSessionsForAccount(provider, accountRef, tmux, {
        ...options,
        fs: fsImpl,
        includeDetached: true
      });

  // 账号是否还参与调度（配置层的 up/down，不是运行态）。默认放行：没有状态索引时
  // 只做会话探测，绝不因为读不到状态就把账号判成停用。
  //
  // 为什么必须过这道闸：停用账号的终端可能还在（用户没关窗口，或 tmux 会话被保留），
  // 旧实现照样 markRuntime，于是「账号已关闭」与「WebUI 显示运行中」同时成立。
  const isAccountEnabled = typeof options.isAccountEnabled === 'function'
    ? options.isAccountEnabled
    : () => true;

  // 该 harness 的回合由什么驱动（provider 合同 sessionSync.mode：hook / polling /
  // unavailable；外部 harness pi/dsh 没有合同 → 'external'）。探测策略据此决定
  // pane 信号是否能熄灯，本模块只负责把声明传下去。
  const resolveHarnessTurnMode = typeof options.resolveHarnessTurnMode === 'function'
    ? options.resolveHarnessTurnMode
    : () => 'external';
  // pane 活动时间在多久以内算「回合仍在跑」。取两个轮询周期：模型流式输出时活动
  // 间隔是亚秒级，30s 静默已经只可能是在等用户输入，不可能在推理。
  const turnActiveWindowMs = Math.max(
    intervalMs * 2,
    Number(options.turnActiveWindowMs) || Math.max(30_000, intervalMs * 2)
  );

  let timer = null;
  let knownScopes = null;
  let knownScopesAt = 0;

  /** 已知账号范围（provider → accountRef 集合），按 SCOPES_CACHE_MS 刷新。 */
  function readKnownScopes() {
    const nowMs = Date.now();
    if (knownScopes && nowMs - knownScopesAt < SCOPES_CACHE_MS) return knownScopes;
    const scopes = new Map();
    for (const record of (listAccountRefs() || [])) {
      const provider = normalizeProvider(record && record.provider);
      const accountRef = normalizeText(record && record.accountRef);
      if (!provider || !accountRef) continue;
      if (!scopes.has(provider)) scopes.set(provider, new Set());
      scopes.get(provider).add(accountRef);
    }
    knownScopes = scopes;
    knownScopesAt = nowMs;
    return knownScopes;
  }

  /** 本轮要探测的 (harnessId, accountRef)：注册表条目优先，且必须还在账号范围里。 */
  function listScopes() {
    const known = readKnownScopes();
    const seen = new Set();
    const scopes = [];
    for (const entry of (listRegistryEntries() || [])) {
      const provider = normalizeProvider(entry && entry.provider);
      const accountRef = normalizeText(entry && entry.accountRef);
      if (!provider || !accountRef) continue;
      // gateway 作用域没有账号身份，跳过（它的流量由网关 attempt 覆盖）。
      if (entry && entry.gateway === true) continue;
      const knownRefs = known.get(provider);
      if (knownRefs && !knownRefs.has(accountRef)) continue;
      const key = `${provider}:${accountRef}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scopes.push({ harnessId: provider, accountRef });
    }
    return scopes;
  }

  /** 一轮探测：给有存活会话的账号打 in-use 标记。返回可观察的摘要。 */
  function tick() {
    const summary = {
      tmuxAvailable: false,
      scopes: 0,
      skippedDisabled: 0,
      accountsWithSessions: 0,
      sessions: 0,
      attached: 0,
      marked: 0,
      turnActive: 0,
      turnIdle: 0,
      turnSources: {}
    };
    if (!aiHomeDir || !accountActivity || typeof accountActivity.markRuntime !== 'function') {
      return summary;
    }

    const tmux = detectTmux();
    summary.tmuxAvailable = Boolean(tmux && tmux.available);
    if (!summary.tmuxAvailable) return summary;

    const scopes = listScopes();
    summary.scopes = scopes.length;
    const nowMs = Date.now();
    // 每轮共享缓存：会话清单/归属解析按轮读一次，账号再多（1w）也不重复扫目录。
    const tickCache = new Map();
    for (const scope of scopes) {
      // 停用/已删除账号：不探测、不打标。残留标记由生命周期监听者即时清空，
      // 这里只保证不再重新点亮。
      if (!isAccountEnabled(scope.harnessId, scope.accountRef)) {
        summary.skippedDisabled += 1;
        continue;
      }
      const sessions = listSessions(scope.harnessId, scope.accountRef, tmux);
      const live = (Array.isArray(sessions) ? sessions : []).filter((session) => !session.paneDead);
      if (live.length === 0) continue;
      const attached = live.filter((session) => session.attached).length;
      accountActivity.markRuntime(scope.harnessId, scope.accountRef, {
        ttlMs,
        sessions: live.length,
        attached
      });
      summary.accountsWithSessions += 1;
      summary.sessions += live.length;
      summary.attached += attached;
      summary.marked += 1;
      applyHarnessTurnSignals(scope, live, nowMs, summary, tickCache);
    }
    return summary;
  }

  // 回合信号组合：decisive 结束 > 有活动 > 权威空闲 > 不动。
  // 每个 harness 的探测策略由注册表给出（新增 harness 不改本函数）。
  function applyHarnessTurnSignals(scope, live, nowMs, summary, tickCache) {
    if (typeof accountActivity.markSessionTurn !== 'function') return;
    const turnMode = normalizeProvider(resolveHarnessTurnMode(scope.harnessId)) || 'external';
    const context = {
      harnessId: scope.harnessId,
      accountRef: scope.accountRef,
      sessions: live,
      nowMs,
      turnActiveWindowMs,
      turnMode,
      fs: fsImpl,
      path: pathImpl,
      aiHomeDir,
      hostHomeDir,
      cache: tickCache
    };
    const signals = [];
    for (const probe of listHarnessActivityProbes(scope.harnessId)) {
      let signal = null;
      try {
        signal = probe.probe(context);
      } catch (_error) {
        signal = null;
      }
      if (!signal || signal.turn == null) continue;
      signals.push({
        turn: signal.turn === true,
        authority: normalizeProvider(signal.authority),
        decisive: signal.decisive === true,
        lastActivityAt: Math.max(0, Number(signal.lastActivityAt) || 0),
        source: normalizeText(signal.source) || probe.id
      });
    }
    if (signals.length === 0) return;

    const ended = signals.filter((signal) => signal.turn === false);
    const decisiveEnd = ended.find((signal) => signal.decisive);
    if (decisiveEnd) {
      accountActivity.endSessionTurn(scope.harnessId, scope.accountRef);
      summary.turnIdle += 1;
      countTurnSource(summary, decisiveEnd.source);
      return;
    }

    const active = signals.filter((signal) => signal.turn === true);
    const authoritativeIdle = ended.filter((signal) => signal.authority === 'turn');
    const activeAt = active.reduce((max, signal) => Math.max(max, signal.lastActivityAt), 0);
    const idleAt = authoritativeIdle.reduce((max, signal) => Math.max(max, signal.lastActivityAt), 0);
    if (active.length > 0 && activeAt >= idleAt) {
      accountActivity.markSessionTurn(scope.harnessId, scope.accountRef, {
        ttlMs: Math.max(turnActiveWindowMs, ttlMs)
      });
      summary.turnActive += 1;
      const latest = active.reduce((best, signal) => (
        signal.lastActivityAt > best.lastActivityAt ? signal : best
      ), active[0]);
      countTurnSource(summary, latest.source);
      return;
    }
    if (authoritativeIdle.length > 0 && typeof accountActivity.endSessionTurn === 'function') {
      accountActivity.endSessionTurn(scope.harnessId, scope.accountRef);
      summary.turnIdle += 1;
      const latest = authoritativeIdle.reduce((best, signal) => (
        signal.lastActivityAt > best.lastActivityAt ? signal : best
      ), authoritativeIdle[0]);
      countTurnSource(summary, latest.source);
    }
  }

  function start() {
    if (timer || !aiHomeDir || !accountActivity) return false;
    tick();
    timer = setInterval(() => {
      try {
        tick();
      } catch (_error) {
        // 轮询失败只影响 in-use 捕获，绝不影响网关主流程；标记会自然过期。
      }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
  }

  return { start, stop, tick, intervalMs, ttlMs, turnActiveWindowMs };
}

function countTurnSource(summary, source) {
  const key = normalizeText(source) || 'unknown';
  summary.turnSources[key] = (summary.turnSources[key] || 0) + 1;
}

module.exports = {
  createAccountSessionActivityPoller,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_RUNTIME_TTL_MS
};
