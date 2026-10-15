'use strict';

// 账号 in-use 捕获（持久 CLI 会话来源）—— accountActivity 的第三条活跃来源。
//
// 为什么需要它：另两条来源各有一半盲区。
//   * 网关 attempt（begin/end）只在请求经过 aih 时计数；
//   * provider hook（markSessionTurn）只覆盖合同声明 sessionSync.mode='hook' 的
//     provider（codex / claude / gemini / agy / opencode / grok）。
// 其余 provider（kimi / zcode / codebuddy 家族 / cline / qoder / qoder-cn / kiro）的
// CLI 会话在两侧都没有信号：账号列表里 logo 不转、in-use 状态根本捕获不到。
//
// 持久会话注册表对**所有** provider 都成立（socket = aih-<provider>-<accountRef>，
// 见 lib/runtime/persistent-session.js 的寻址模型），所以这里按 (provider, accountRef)
// 轮询存活会话，把它折进 accountActivity。
//
// 设计纪律：本模块不认识任何 provider 名——账号范围来自 account_refs 表，会话来自
// 持久会话后端，两者都是数据驱动的；新增 provider 不需要改这里。
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
      accountsWithSessions: 0,
      sessions: 0,
      attached: 0,
      marked: 0
    };
    if (!aiHomeDir || !accountActivity || typeof accountActivity.markRuntime !== 'function') {
      return summary;
    }

    const tmux = detectTmux();
    summary.tmuxAvailable = Boolean(tmux && tmux.available);
    if (!summary.tmuxAvailable) return summary;

    const scopes = listScopes();
    summary.scopes = scopes.length;
    for (const scope of scopes) {
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
    }
    return summary;
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
