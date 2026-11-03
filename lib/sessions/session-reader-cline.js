'use strict';

/**
 * Cline 会话历史读取（WebUI 会话历史用）。
 *
 * 数据面（<CLINE_DATA_DIR>，见 cline-session-store.js）：
 *   db/sessions.db                     一行一会话（session_id / cwd / started_at / model / prompt …）
 *   sessions/<id>/<id>.messages.json   该会话的完整消息（{messages:[{role, content:[blocks], ts}]}）
 *
 * 这里把 cline 的原生形态翻译成 aih 会话历史的统一形状：
 *   - 项目 = 会话的 cwd（cline 的会话按 cwd 归属，与其它 provider 一致）；
 *   - 会话 = sessions.db 的一行（title 取首条 prompt，updatedAt 取 updated_at）；
 *   - 消息 = messages.json 的条目，content blocks 复用 provider-session-adapters 的
 *     legacy 渲染（thinking → :::thinking、tool_use/tool_result → :::tool），
 *     与 claude / codebuddy 的历史渲染保持同一形态。
 *
 * 全部只读、best-effort：读不到就返回空，绝不抛出。
 */

const path = require('node:path');
const {
  getDatabaseSyncCtor,
  resolveClineDataDir,
  resolveClineHistoryDataDir,
  readClineSessionRecords,
  readClineSessionRecordsAcrossAccounts,
  resolveClineMessagesDataDirs,
  normalizeSessionId
} = require('./cline-session-store');
const { renderProviderBlocksToLegacyContent } = require('./provider-session-adapters');

function resolveClineSessionsDir(options = {}) {
  // 会话历史统一走 resolveClineHistoryDataDir：指定账号时是投影，未指定时是宿主共享存储。
  const dataDir = resolveClineHistoryDataDir({
    aiHomeDir: options.aiHomeDir,
    accountRef: options.accountRef,
    hostHomeDir: options.hostHomeDir,
    path: options.path
  });
  return dataDir ? path.join(dataDir, 'sessions') : '';
}

// 会话文件：<data>/sessions/<id>/<id>.messages.json。文件不存在时返回 ''——
// 调用方（消息缓存 / 历史读取 / 恢复）据此判定「这段会话没有可读历史」，
// 而不是拿一个不存在的路径去读（与 grok 的会话目录解析同一口径）。
function resolveClineSessionPath(sessionId, options = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id) return '';
  const fsImpl = options.fs || require('node:fs');
  // 跨账号：会话文件可能落在任意账号的数据根下（DB 池能读到那一行，消息文件也要能找到）。
  const dirs = resolveClineMessagesDataDirs({
    fs: fsImpl,
    path: options.path,
    aiHomeDir: options.aiHomeDir,
    accountRef: options.accountRef,
    hostHomeDir: options.hostHomeDir
  });
  for (const dataDir of dirs) {
    const filePath = path.join(dataDir, 'sessions', id, `${id}.messages.json`);
    try {
      if (fsImpl.existsSync(filePath)) return filePath;
    } catch (_error) { /* 下一个 */ }
  }
  return '';
}

function readClineSessionRecordsForHistory(options = {}) {
  // 指定账号 → 只读该账号（原生身份的判定不能串账号）。
  // 未指定账号（WebUI 全量列表）→ 跨账号 DB 池归并：每个账号的库各归各的，
  // 不合并、不复制行，只读地并起来（见 cline-session-store.readClineSessionRecordsAcrossAccounts）。
  if (!options.accountRef && options.aiHomeDir) {
    const pooled = readClineSessionRecordsAcrossAccounts({
      fs: options.fs,
      path: options.path,
      aiHomeDir: options.aiHomeDir,
      hostHomeDir: options.hostHomeDir,
      DatabaseSync: getDatabaseSyncCtor(options)
    });
    if (pooled.records.length > 0) return pooled.records;
  }
  const dataDir = resolveClineHistoryDataDir({
    aiHomeDir: options.aiHomeDir,
    accountRef: options.accountRef,
    hostHomeDir: options.hostHomeDir,
    path: options.path
  });
  if (!dataDir) return [];
  return readClineSessionRecords({
    fs: options.fs,
    path: options.path,
    dataDir,
    DatabaseSync: getDatabaseSyncCtor(options)
  });
}

function readClineProjects(options = {}) {
  const projectsByPath = new Map();
  for (const record of readClineSessionRecordsForHistory(options)) {
    const projectPath = String(record.cwd || '').trim();
    if (!projectPath) continue;
    const session = {
      id: record.sessionId,
      title: record.title || record.sessionId,
      updatedAt: record.updatedAtMs || record.startedAtMs || 0,
      provider: 'cline',
      projectDirName: projectPath,
      ...(record.model ? { model: record.model } : {}),
      ...(options.accountRef ? { accountRef: options.accountRef } : {})
    };
    const sessions = projectsByPath.get(projectPath) || new Map();
    sessions.set(session.id, session);
    projectsByPath.set(projectPath, sessions);
  }
  return Array.from(projectsByPath.entries()).map(([projectPath, sessions]) => ({
    id: `cline-${Buffer.from(projectPath).toString('base64url')}`,
    name: path.basename(projectPath) || projectPath,
    path: projectPath,
    provider: 'cline',
    sessions: Array.from(sessions.values()).sort((left, right) => right.updatedAt - left.updatedAt),
    ...(options.accountRef ? { accountRef: options.accountRef } : {})
  }));
}

function readClineSessionModel(sessionId, options = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id) return '';
  const record = readClineSessionRecordsForHistory(options).find((item) => item.sessionId === id);
  return record ? record.model : '';
}

// cline 的 content blocks → provider-session-adapters 的 legacy 文本。
// 图片（{type:'image'}）在历史里只留占位：base64 原图不进会话历史。
function clineBlocksToLegacyBlocks(blocks) {
  const mapped = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      mapped.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      mapped.push({ type: 'reasoning', text: block.thinking });
    } else if (block.type === 'tool_use') {
      mapped.push({ type: 'tool_call', name: block.name, args: block.input });
    } else if (block.type === 'tool_result') {
      mapped.push({ type: 'tool_result', name: block.name, body: block.content });
    } else if (block.type === 'image') {
      mapped.push({ type: 'text', text: `[image ${String(block.mediaType || '')}]`.trim() });
    }
  }
  return mapped;
}

function toIsoTimestamp(value) {
  const ms = Number(value) || 0;
  return ms > 0 ? new Date(ms).toISOString() : '';
}

function readClineSessionMessages(sessionId, options = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id) return [];
  const filePath = resolveClineSessionPath(id, options);
  if (!filePath) return [];
  const fsImpl = options.fs || require('node:fs');
  let payload = null;
  try {
    payload = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return [];
  }
  const entries = Array.isArray(payload && payload.messages) ? payload.messages : [];
  const messages = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const role = String(entry.role || '').trim();
    if (role !== 'user' && role !== 'assistant') continue;
    const content = renderProviderBlocksToLegacyContent(clineBlocksToLegacyBlocks(entry.content));
    if (!content) continue;
    messages.push({
      role,
      content,
      timestamp: toIsoTimestamp(entry.ts)
    });
  }
  return messages;
}

module.exports = {
  resolveClineSessionsDir,
  resolveClineSessionPath,
  readClineProjects,
  readClineSessionMessages,
  readClineSessionModel
};
