'use strict';

// 账号 in-use 捕获（持久 CLI 会话来源）—— accountActivity 的第三条活跃来源。
//
// 为什么需要它：另两条来源各有一半盲区。
//   * 网关 attempt（begin/end）只在请求经过 aih 时计数；
//   * provider hook（markSessionTurn）只覆盖合同声明 sessionSync.mode='hook' 的
//     provider（codex / claude / gemini / agy / opencode / grok）。
// 其余 provider（kimi / zcode / codebuddy 家族 / cline / qoder / qoder-cn / kiro）的
// CLI 会话没有 hook 事件，回合活性只能靠观测。
//
// 持久会话注册表对**所有** provider 都成立（socket = aih-<provider>-<accountRef>，
// 见 lib/runtime/persistent-session.js 的寻址模型），所以这里按 (provider, accountRef)
// 轮询存活会话。两个层次严格分开：
//
//   1) 「终端开着」= markRuntime：只用于展示（几个会话、几个在用），**不点亮转圈**。
//      用户只是 `aih <provider> <id>` 打开了一个空 CLI，不代表账号在服务。
//   2) 「正在跑回合」= markSessionTurn：由 tmux 的 window_activity（会话当前窗口最后
//      一次有输出的时刻）判定。模型答题时 pane 必然持续产出，静默即为空闲。这是对
//      没有官方 hook 的 provider 的统一兜底，也是本模块不认识任何 provider 名的
//      原因——信号来自持久会话后端，不是 provider 特有格式。
//   合同声明 sessionSync.mode='hook' 的 provider 只接受「有输出 → 一定在跑」这一个
//   方向，熄灯仍由权威 hook 事件负责。
//
// 停用账号（配置层 status=down）一律跳过：终端还开着也不能显示「运行中」。
//
// 与 hook 回合一致，用「标记 + TTL」而不是 begin/end 计数：轮询进程被杀、tmux 暂时
// 不可用（超时/忙）都只会让标记自然过期，不会永久泄漏成「一直在转圈」。

const { listAccountRefRecords } = require('./account-ref-store');
const persistentSessionRegistry = require('../runtime/persistent-session-registry');
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
  const aiHomeDir = normalizeText(options.aiHomeDir);
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

  // 该 provider 的会话回合由什么驱动（合同 sessionSync.mode：hook / polling / unavailable）。
  //
  // 有 hook 的 provider 以 hook 事件为权威回合信号（markSessionTurn / endSessionTurn
  // 由 hook 路由直接调用）；没有 hook 的 provider 由本模块用 pane 活动时间兜底：
  // 模型在答题时 pane 一定在产出，静默即空闲。默认按 polling 处理——探测不到活动
  // 时间（0）时不做任何结束判断，宁可不熄灯也不误判。
  const resolveSessionSyncMode = typeof options.resolveSessionSyncMode === 'function'
    ? options.resolveSessionSyncMode
    : () => 'polling';
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

  /** 本轮要探测的 (provider, accountRef)：注册表条目优先，且必须还在账号范围里。 */
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
      scopes.push({ provider, accountRef });
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
      turnIdle: 0
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
    for (const scope of scopes) {
      // 停用/已删除账号：不探测、不打标。残留标记由生命周期监听者即时清空，
      // 这里只保证不再重新点亮。
      if (!isAccountEnabled(scope.provider, scope.accountRef)) {
        summary.skippedDisabled += 1;
        continue;
      }
      const sessions = listSessions(scope.provider, scope.accountRef, tmux);
      const live = (Array.isArray(sessions) ? sessions : []).filter((session) => !session.paneDead);
      if (live.length === 0) continue;
      const attached = live.filter((session) => session.attached).length;
      accountActivity.markRuntime(scope.provider, scope.accountRef, {
        ttlMs,
        sessions: live.length,
        attached
      });
      summary.accountsWithSessions += 1;
      summary.sessions += live.length;
      summary.attached += attached;
      summary.marked += 1;
      applySessionTurnSignal(scope, live, nowMs, summary);
    }
    return summary;
  }

  // 用「pane 最后一次活动时间」判定回合活性（没有官方 hook 时的兜底）。
  //
  // 只对合同 sessionSync.mode !== 'hook' 的 provider 做「熄灯」判断：hook provider
  // 的回合结束由权威事件决定，这里只补充「有输出 → 一定在跑」这一个方向。
  function applySessionTurnSignal(scope, live, nowMs, summary) {
    if (typeof accountActivity.markSessionTurn !== 'function') return;
    const mode = String(resolveSessionSyncMode(scope.provider) || '').trim().toLowerCase();
    const activityAtList = live
      .map((session) => Number(session.lastActivityAt) || 0)
      .filter((value) => value > 0);
    // 平台/版本拿不到活动时间：信号未知，保持现状（既不打标也不熄灯）。
    if (activityAtList.length === 0) return;
    const lastActivityAt = Math.max(...activityAtList);
    const active = nowMs - lastActivityAt <= turnActiveWindowMs;
    if (active) {
      accountActivity.markSessionTurn(scope.provider, scope.accountRef, {
        ttlMs: Math.max(turnActiveWindowMs, ttlMs)
      });
      summary.turnActive += 1;
      return;
    }
    if (mode === 'hook') return;
    if (typeof accountActivity.endSessionTurn === 'function') {
      accountActivity.endSessionTurn(scope.provider, scope.accountRef);
      summary.turnIdle += 1;
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

  return { start, stop, tick, intervalMs, ttlMs };
}

module.exports = {
  createAccountSessionActivityPoller,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_RUNTIME_TTL_MS
};
