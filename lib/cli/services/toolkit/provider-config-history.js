'use strict';

// Provider 配置文件的本机版本历史。
//
// 存储位置：<AIH_HOME_DIR>/run/provider-config-history/<provider>/<fileId>/history.json
// 目录 0700、文件 0600；历史内容包含配置文件原文（可能含凭据），因此只在
// 本机保存，不进入导出、不进入日志。条目上限 30 条，按 revision 去重。
//
// 这里的职责只有“读写快照”，写回文件由 provider-config-manager 负责，
// 这样版本历史与文件校验/原子替换可以分别测试。

const crypto = require('node:crypto');

const MAX_HISTORY_ENTRIES = 30;
const HISTORY_SCHEMA_VERSION = 1;

function safeSegment(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return /^[a-zA-Z0-9._-]+$/.test(raw) ? raw : encodeURIComponent(raw);
}

function historyRoot(options = {}) {
  const path = options.path || require('node:path');
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir) throw new Error('aiHomeDir is required for provider config history');
  return path.join(aiHomeDir, 'run', 'provider-config-history');
}

function historyFile(provider, fileId, options = {}) {
  const path = options.path || require('node:path');
  return path.join(historyRoot(options), safeSegment(provider), safeSegment(fileId), 'history.json');
}

function readHistoryDocument(provider, fileId, options = {}) {
  const fs = options.fs || require('node:fs');
  const target = historyFile(provider, fileId, options);
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!parsed || !Array.isArray(parsed.entries)) return { version: HISTORY_SCHEMA_VERSION, entries: [] };
    return {
      version: HISTORY_SCHEMA_VERSION,
      entries: parsed.entries.filter((entry) => entry && entry.id && typeof entry.content === 'string')
    };
  } catch (_error) {
    return { version: HISTORY_SCHEMA_VERSION, entries: [] };
  }
}

function writeHistoryDocument(provider, fileId, document, options = {}) {
  const fs = options.fs || require('node:fs');
  const path = options.path || require('node:path');
  const target = historyFile(provider, fileId, options);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch (_error) {
    // 某些平台（例如 Windows）不支持 chmod，失败不影响内容。
  }
}

function summarizeEntry(entry) {
  return {
    id: entry.id,
    revision: entry.revision,
    savedAt: entry.savedAt,
    reason: entry.reason,
    note: entry.note || '',
    size: entry.size,
    containsSecrets: entry.containsSecrets === true
  };
}

function listHistoryEntries(provider, fileId, options = {}) {
  const document = readHistoryDocument(provider, fileId, options);
  return document.entries
    .slice()
    .sort((left, right) => right.savedAt - left.savedAt)
    .map(summarizeEntry);
}

function appendHistoryEntry(provider, fileId, entry, options = {}) {
  const document = readHistoryDocument(provider, fileId, options);
  const revision = String(entry.revision || '').trim();
  if (!revision) return null;
  const last = document.entries[document.entries.length - 1];
  if (last && last.revision === revision && last.content === entry.content) {
    return summarizeEntry(last);
  }
  // 同一毫秒内连续写入（tmpfs / CI runner 上很常见）会让历史按时间排序时并列，
  // 旧记录因此可能排到新记录前面。写入时保证 savedAt 严格递增。
  const requestedSavedAt = Number(entry.savedAt || Date.now());
  const previousSavedAt = last && Number.isFinite(Number(last.savedAt)) ? Number(last.savedAt) : 0;
  const savedAt = requestedSavedAt > previousSavedAt ? requestedSavedAt : previousSavedAt + 1;
  const id = `${savedAt}-${revision.slice(0, 8)}-${crypto.randomBytes(3).toString('hex')}`;
  const record = {
    id,
    revision,
    savedAt,
    reason: String(entry.reason || 'save'),
    note: String(entry.note || '').slice(0, 200),
    size: Buffer.byteLength(String(entry.content || ''), 'utf8'),
    containsSecrets: entry.containsSecrets === true,
    content: String(entry.content || '')
  };
  document.entries.push(record);
  if (document.entries.length > MAX_HISTORY_ENTRIES) {
    document.entries = document.entries.slice(-MAX_HISTORY_ENTRIES);
  }
  document.version = HISTORY_SCHEMA_VERSION;
  writeHistoryDocument(provider, fileId, document, options);
  return summarizeEntry(record);
}

function getHistoryEntry(provider, fileId, entryId, options = {}) {
  const document = readHistoryDocument(provider, fileId, options);
  const id = String(entryId || '').trim();
  const entry = document.entries.find((item) => item.id === id) || null;
  if (!entry) return null;
  return { ...summarizeEntry(entry), content: entry.content };
}

module.exports = {
  HISTORY_SCHEMA_VERSION,
  MAX_HISTORY_ENTRIES,
  appendHistoryEntry,
  getHistoryEntry,
  historyFile,
  historyRoot,
  listHistoryEntries,
  readHistoryDocument
};
