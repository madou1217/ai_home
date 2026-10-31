'use strict';

/**
 * `aih ss <TAB>` 的候选：本机的持久会话（pane）。
 *
 * 为什么不用 collectGlobalPersistentSessionRows：那个函数为了渲染列表会**逐个 socket 去问
 * tmux**，实测 2 秒；TAB 的预算是 100ms。这里改读持久会话注册表（一个 JSON），
 * 只补标题、project、时间，不探测 liveness。真正的 `aih ss` 仍走完整采集。
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function basenameOf(value) {
  const text = String(value || '').trim().replace(/[\\/]+$/, '');
  return text ? nodePath.basename(text) : '';
}

function listPersistentSessionNames(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const env = options.env || process.env;
  let aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir) {
    try { aiHomeDir = require('../../runtime/aih-home').resolveAiHomeDir({ env }); } catch (_error) { aiHomeDir = ''; }
  }
  if (!aiHomeDir) return [];

  let entries = [];
  try {
    const registry = require('../../runtime/persistent-session-registry');
    entries = registry.listEntries(aiHomeDir, { fs: fsImpl }) || [];
  } catch (_error) {
    return [];
  }

  // 原生标题（有 nativeSessionId 的才有）：每个 provider 只读一次会话库。
  const titlesByProvider = new Map();
  const titleOf = (provider, sessionId) => {
    if (!provider || !sessionId) return '';
    if (!titlesByProvider.has(provider)) {
      let list = [];
      try {
        const { listProviderSessions } = require('./candidates');
        list = listProviderSessions(provider, { limit: 50, aiHomeDir, env, hostHomeDir: options.hostHomeDir }) || [];
      } catch (_error) { list = []; }
      titlesByProvider.set(provider, new Map(list.map((session) => [session.id, session.title || ''])));
    }
    return String(titlesByProvider.get(provider).get(sessionId) || '').trim();
  };

  // 标题缓存：真实跑过 aih ss 之后，这里存着 agent 写的标题与 liveness。
  const cachedByName = new Map();
  try {
    const cache = require('../../runtime/persistent-session-cache');
    for (const row of cache.read(aiHomeDir, { fs: fsImpl })) {
      if (row && row.name) cachedByName.set(row.name, row);
    }
  } catch (_error) { /* 没有缓存就用注册表里的项目名 */ }

  const cwd = String(options.cwd || process.cwd() || '').replace(/\/+$/, '');
  return entries
    .filter((entry) => entry && entry.session && !entry.unrecoverable)
    .map((entry) => {
      const provider = String(entry.provider || '').trim();
      const projectPath = String(entry.cwd || '').trim();
      const nativeId = String(entry.nativeSessionId || '').trim();
      const nativeTitle = titleOf(provider, nativeId);
      const fallback = String(entry.label || '').trim() || basenameOf(projectPath) || provider;
      const createdAt = Number(entry.createdAt) || 0;
      const updatedAt = Number(entry.updatedAt) || createdAt;
      const name = String(entry.session || '').trim();
      const cached = cachedByName.get(name);
      const cachedTitle = String((cached && cached.title) || '').trim();
      return {
        name,
        title: clip(nativeTitle || cachedTitle || fallback, 60),
        hasNativeTitle: Boolean(nativeTitle),
        provider: provider || String((cached && cached.provider) || '').trim(),
        projectPath,
        nativeSessionId: nativeId,
        createdAt: createdAt || Number(cached && cached.createdAt) || 0,
        updatedAt: Number(cached && cached.updatedAt) || updatedAt,
        here: Boolean(cwd) && projectPath.replace(/\/+$/, '') === cwd,
        live: Boolean(cached && cached.live)
      };
    })
    .sort((left, right) => Number(right.here) - Number(left.here) || right.updatedAt - left.updatedAt);
}

module.exports = {
  listPersistentSessionNames
};
