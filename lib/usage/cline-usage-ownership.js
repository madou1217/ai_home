'use strict';

// cline 用量归属：共享会话库下的「哪段对话属于哪个 aih 账号」。
//
// 背景：cline 的会话数据（`~/.cline/data/sessions/**`）被 aih 主动链回宿主
// （lib/runtime/launch-profile/cline-shared-session-store.js），所以文件本身没有账号
// 边界——会话文件里的 provider 是 `cline-pass` 这类原生供应商，不是 aih 账号。
// 唯一持久的账号作用域来自持久会话注册表：每个 pane 一条 `$AIH_HOME/run/
// persistent-sessions/*.json`，带 provider/accountRef/cwd/createdAt/updatedAt
// （见 lib/runtime/persistent-session-registry.js）。这与 codex / zcode 的做法一致：
// 用注册表作用域把原生会话归到账号，而不是猜。
//
// 判定规则（诚实降级）：只有「cwd 相同且会话开始时间落在该账号作用域存活窗口内」的
// 候选账号**唯一**时才归属；0 个或多个候选一律返回未归属，绝不猜。

const { isAccountRef } = require('../account/public-account-ref');
const persistentSessionRegistry = require('../runtime/persistent-session-registry');

// 注册表条目与 provider 会话记录之间的时钟/落盘抖动余量。
const SCOPE_GRACE_MS = 2 * 60 * 1000;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizePath(value) {
  return normalizeText(value).replace(/\/+$/, '');
}

function createClineUsageOwnership(options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const aiHomeDir = normalizeText(options.aiHomeDir);
  const registry = options.registry || persistentSessionRegistry;
  const scopes = [];

  let entries = [];
  if (aiHomeDir && registry && typeof registry.listEntries === 'function') {
    try {
      entries = registry.listEntries(aiHomeDir, { fs: fsImpl });
    } catch (_error) {
      entries = [];
    }
  }
  for (const entry of entries) {
    if (!entry || normalizeText(entry.provider).toLowerCase() !== 'cline') continue;
    const accountRef = normalizeText(entry.accountRef);
    if (!isAccountRef(accountRef)) continue;
    const createdAt = Number(entry.createdAt) || 0;
    if (!createdAt) continue;
    const updatedAt = Math.max(createdAt, Number(entry.updatedAt) || 0);
    scopes.push({
      accountRef,
      cwd: normalizePath(entry.cwd),
      from: createdAt - SCOPE_GRACE_MS,
      to: updatedAt + SCOPE_GRACE_MS
    });
  }

  /** 会话（cwd + 开始时间）→ { accountRef, reason }；accountRef 为空即未归属。 */
  function resolve(session = {}) {
    const startedAtMs = Number(session.startedAtMs) || 0;
    if (!startedAtMs) return { accountRef: '', reason: 'no_start_time' };
    const cwd = normalizePath(session.cwd);
    const matches = new Set();
    for (const scope of scopes) {
      if (scope.cwd && cwd && scope.cwd !== cwd) continue;
      if (startedAtMs < scope.from || startedAtMs > scope.to) continue;
      matches.add(scope.accountRef);
    }
    if (matches.size === 1) return { accountRef: [...matches][0], reason: 'scope' };
    return { accountRef: '', reason: matches.size > 1 ? 'ambiguous_scope' : 'no_scope' };
  }

  return { resolve, scopeCount: scopes.length };
}

module.exports = {
  createClineUsageOwnership,
  SCOPE_GRACE_MS
};
