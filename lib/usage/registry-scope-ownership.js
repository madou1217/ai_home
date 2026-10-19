'use strict';

// 宿主共享会话库的账号归属（与 provider 无关的通用实现）。
//
// 背景：cline / kiro 这类 CLI 把会话写进宿主共享目录（~/.cline、~/.kiro），文件本身没有
// 账号边界。唯一持久的账号作用域来自持久会话注册表：每个 aih pane 一条
// `$AIH_HOME_DIR/run/persistent-sessions/*.json`，带 provider/accountRef/cwd/createdAt/updatedAt
// （lib/runtime/persistent-session-registry.js）。
//
// 判定规则（诚实降级）：只有「cwd 相同且时间点落在该账号作用域存活窗口内」的候选账号
// **唯一**时才归属；0 个或多个候选一律返回未归属，绝不猜。

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

/**
 * @param {{provider: string, fs?: object, aiHomeDir: string, registry?: object}} options
 * @returns {{resolve: Function, scopeCount: number}}
 */
function createRegistryScopeOwnership(options = {}) {
  const provider = normalizeText(options.provider).toLowerCase();
  const fsImpl = options.fs || require('node:fs');
  const aiHomeDir = normalizeText(options.aiHomeDir);
  const registry = options.registry || persistentSessionRegistry;
  const scopes = [];

  let entries = [];
  if (provider && aiHomeDir && registry && typeof registry.listEntries === 'function') {
    try {
      entries = registry.listEntries(aiHomeDir, { fs: fsImpl });
    } catch (_error) {
      entries = [];
    }
  }
  for (const entry of entries) {
    if (!entry || normalizeText(entry.provider).toLowerCase() !== provider) continue;
    // 网关作用域每次请求才选账号，没有固定归属。
    if (entry.gateway === true) continue;
    const accountRef = normalizeText(entry.accountRef);
    if (!isAccountRef(accountRef)) continue;
    const createdAt = Number(entry.createdAt) || 0;
    if (!createdAt) continue;
    const updatedAt = Math.max(createdAt, Number(entry.updatedAt) || 0);
    // supervisor 托管的条目在 pane 退出时由 supervisor 删除（persistent-provider-supervisor-entry），
    // 所以「条目还在且未标不可恢复」就是 pane 仍存活：作用域开放到现在。updatedAt 只在恢复/对账时
    // 刷新，拿它当上界会把存活 pane 最近的事件判成未归属（2026-10-19 kiro 实测）。
    const live = entry.supervisorManaged === true && !normalizeText(entry.unrecoverable);
    scopes.push({
      accountRef,
      cwd: normalizePath(entry.cwd),
      from: createdAt - SCOPE_GRACE_MS,
      to: live ? Number.POSITIVE_INFINITY : updatedAt + SCOPE_GRACE_MS
    });
  }

  /**
   * 会话（cwd + 时间点）→ { accountRef, reason }；accountRef 为空即未归属。
   * 时间点优先用 atMs（单条事件），否则 startedAtMs（整段会话）。
   */
  function resolve(session = {}) {
    const atMs = Number(session.atMs) || Number(session.startedAtMs) || 0;
    if (!atMs) return { accountRef: '', reason: 'no_start_time' };
    const cwd = normalizePath(session.cwd);
    const matches = new Set();
    for (const scope of scopes) {
      if (scope.cwd && cwd && scope.cwd !== cwd) continue;
      if (atMs < scope.from || atMs > scope.to) continue;
      matches.add(scope.accountRef);
    }
    if (matches.size === 1) return { accountRef: [...matches][0], reason: 'scope' };
    return { accountRef: '', reason: matches.size > 1 ? 'ambiguous_scope' : 'no_scope' };
  }

  return { resolve, scopeCount: scopes.length };
}

module.exports = {
  createRegistryScopeOwnership,
  SCOPE_GRACE_MS
};
