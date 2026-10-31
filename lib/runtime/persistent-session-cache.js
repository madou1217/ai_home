'use strict';

/**
 * 持久会话候选的**标题缓存**。
 *
 * `aih ss` 的完整采集要逐 socket 问 tmux（实测 ~2s），TAB 用不起；但注册表里只有 pane 名，
 * 没有 agent 写的标题（✳ 本地合并取代 AWS）。折中：真实运行 `aih ss` 时把采集结果写进
 * 这份缓存，TAB 优先读它（毫秒级），没有缓存再退回注册表里的项目名。
 *
 * 缓存只服务「显示」：进入会话仍然以注册表/tmux 为准。
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const CACHE_FILE = 'ss-rows.json';
const CACHE_TTL_MS = 30 * 60 * 1000;

function cachePath(aiHomeDir) {
  const home = String(aiHomeDir || '').trim();
  return home ? nodePath.join(home, 'run', 'cache', 'complete', CACHE_FILE) : '';
}

function write(aiHomeDir, rows, options = {}) {
  const file = cachePath(aiHomeDir);
  if (!file) return false;
  try {
    const fsImpl = options.fs || nodeFs;
    const payload = {
      at: Date.now(),
      rows: (Array.isArray(rows) ? rows : []).map((row) => ({
        name: String((row && row.name) || '').trim(),
        title: String((row && (row.title || row.description)) || '').trim(),
        provider: String((row && row.provider) || '').trim(),
        projectPath: String((row && row.path) || '').trim(),
        live: Boolean(row && row.live),
        here: Boolean(row && row.here),
        createdAt: Number(row && row.created) || 0,
        updatedAt: Date.now()
      })).filter((row) => row.name)
    };
    fsImpl.mkdirSync(nodePath.dirname(file), { recursive: true });
    fsImpl.writeFileSync(file, JSON.stringify(payload), 'utf8');
    return true;
  } catch (_error) {
    return false;
  }
}

function read(aiHomeDir, options = {}) {
  const file = cachePath(aiHomeDir);
  if (!file) return [];
  try {
    const fsImpl = options.fs || nodeFs;
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.rows)) return [];
    if (Date.now() - Number(parsed.at || 0) > CACHE_TTL_MS) return [];
    return parsed.rows;
  } catch (_error) {
    return [];
  }
}

module.exports = { CACHE_FILE, CACHE_TTL_MS, read, write };
