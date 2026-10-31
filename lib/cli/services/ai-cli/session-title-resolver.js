'use strict';

const path = require('node:path');
const {
  buildHostPathLookupVariants,
  normalizeHostPathForLookup
} = require('../../../runtime/windows-path-encoding');
const { getRealHome } = require('../../../sessions/session-reader-utils');
const {
  normalizeSessionId: normalizeClineSessionId,
  extractClineSessionId,
  resolveClineDataDir,
  readClineSessionRecords,
  findClineSessionCandidates
} = require('../../../sessions/cline-session-store');

const TITLE_MAX_LENGTH = 120;
const SESSION_MATCH_TOLERANCE_SECONDS = 10;
const TITLE_SCAN_MAX_BYTES = 1024 * 1024;

function normalizeProjectPath(value) {
  const text = String(value || '').trim();
  return text ? normalizeHostPathForLookup(text) : '';
}

function compactTitle(value) {
  return String(value == null ? '' : value)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\\[rnt]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX_LENGTH);
}

function isSyntheticThreadTitle(value) {
  const title = compactTitle(value);
  return title.startsWith('# AGENTS.md instructions')
    || title.startsWith('<codex_internal_context')
    || title.startsWith('<environment_context')
    || title.startsWith('<goal_context')
    || title.startsWith('<turn_aborted')
    || title.startsWith('<user_instructions')
    || title.startsWith('<user_shell_command')
    || title.includes('<INSTRUCTIONS>');
}

function extractObjectiveTitleFromText(value) {
  const match = String(value || '').match(/<objective(?:\s+[^>]*)?>\s*([\s\S]*?)\s*<\/objective>/i);
  return match ? compactTitle(match[1]) : '';
}

function stripEmbeddedSessionPickerTranscript(value) {
  const title = compactTitle(value);
  const markerIndex = title.indexOf('[aih] 选择要进入的持久会话');
  if (markerIndex < 0) return title;
  return title.slice(0, markerIndex).trim().replace(/[\s:：-]+$/, '').trim();
}

function isUsableTitle(value) {
  const title = compactTitle(value);
  if (!title) return false;
  if (title === 'Warmup' || title === '未命名会话') return false;
  if (title.startsWith('Caveat:') || title.startsWith('<command-name>') || title.startsWith('<local-command')) return false;
  return !isSyntheticThreadTitle(title);
}

function sanitizeThreadTitle(value) {
  const objectiveTitle = extractObjectiveTitleFromText(value);
  if (objectiveTitle) return stripEmbeddedSessionPickerTranscript(objectiveTitle);
  const title = stripEmbeddedSessionPickerTranscript(value);
  return isUsableTitle(title) ? title : '';
}

function toSeconds(value) {
  const number = Number(value) || 0;
  if (!number) return 0;
  return number > 100000000000 ? Math.floor(number / 1000) : Math.floor(number);
}

function compareByUpdatedDesc(left, right) {
  return (toSeconds(right.updatedAt) - toSeconds(left.updatedAt))
    || (toSeconds(right.createdAt) - toSeconds(left.createdAt));
}

function buildThreadMatch(session, record) {
  if (!isUsableTitle(record && record.title)) return null;
  const sessionCreatedAt = toSeconds(session && session.created);
  if (!sessionCreatedAt) {
    return { record, rank: 2, distance: 0 };
  }

  const createdAt = toSeconds(record && record.createdAt);
  const updatedAt = toSeconds(record && record.updatedAt);
  if (createdAt) {
    const createdDistance = Math.abs(createdAt - sessionCreatedAt);
    if (createdDistance <= SESSION_MATCH_TOLERANCE_SECONDS) {
      return { record, rank: 0, distance: createdDistance };
    }
  }

  if (
    createdAt
    &&
    createdAt <= sessionCreatedAt + SESSION_MATCH_TOLERANCE_SECONDS
    && (!updatedAt || updatedAt >= sessionCreatedAt - SESSION_MATCH_TOLERANCE_SECONDS)
  ) {
    return {
      record,
      rank: 1,
      distance: createdAt ? Math.max(0, sessionCreatedAt - createdAt) : Number.MAX_SAFE_INTEGER
    };
  }

  return null;
}

function compareThreadMatches(left, right) {
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.rank === 0 && left.distance !== right.distance) return left.distance - right.distance;
  const updated = compareByUpdatedDesc(left.record, right.record);
  if (updated) return updated;
  if (left.distance !== right.distance) return left.distance - right.distance;
  return toSeconds(left.session && left.session.created) - toSeconds(right.session && right.session.created);
}

function chooseBestThreadForSession(session, threadRecords) {
  const candidates = (Array.isArray(threadRecords) ? threadRecords : [])
    .filter((record) => isUsableTitle(record && record.title))
    .map((record) => buildThreadMatch(session, record))
    .filter(Boolean)
    .map((match) => ({ ...match, session }))
    .sort(compareThreadMatches);

  return candidates.length ? candidates[0].record : null;
}

function buildThreadRecordsByPath(records) {
  const byPath = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const cwd = normalizeProjectPath(record && record.cwd);
    if (!cwd || !isUsableTitle(record && record.title)) continue;
    const entry = {
      ...record,
      cwd,
      title: compactTitle(record.title),
      createdAt: toSeconds(record.createdAt),
      updatedAt: toSeconds(record.updatedAt)
    };
    if (!byPath.has(cwd)) byPath.set(cwd, []);
    byPath.get(cwd).push(entry);
  }
  for (const sessions of byPath.values()) {
    sessions.sort(compareByUpdatedDesc);
  }
  return byPath;
}

function listCodexStateDbPaths(codexDir, fsImpl) {
  try {
    return fsImpl.readdirSync(codexDir)
      .filter((entryName) => /^state_\d+\.sqlite$/i.test(entryName))
      .map((entryName) => path.join(codexDir, entryName))
      .sort((left, right) => {
        const leftVersion = Number((path.basename(left).match(/^state_(\d+)\.sqlite$/i) || [])[1]) || 0;
        const rightVersion = Number((path.basename(right).match(/^state_(\d+)\.sqlite$/i) || [])[1]) || 0;
        if (leftVersion !== rightVersion) return rightVersion - leftVersion;
        try {
          return fsImpl.statSync(right).mtimeMs - fsImpl.statSync(left).mtimeMs;
        } catch (_error) {
          return 0;
        }
      });
  } catch (_error) {
    return [];
  }
}

function getDatabaseSyncCtor(options = {}) {
  if (options.DatabaseSync) return options.DatabaseSync;
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    return null;
  }
}

function getSqliteTableColumns(db, tableName) {
  try {
    return new Set(
      db.prepare(`PRAGMA table_info(${tableName})`).all()
        .map((row) => String(row && row.name || '').trim())
        .filter(Boolean)
    );
  } catch (_error) {
    return new Set();
  }
}

function readCodexSessionNameMap(codexDir, fsImpl) {
  const indexPath = path.join(codexDir, 'session_index.jsonl');
  const names = new Map();
  try {
    if (!fsImpl.existsSync(indexPath)) return names;
    const lines = String(fsImpl.readFileSync(indexPath, 'utf8') || '').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry = null;
      try { entry = JSON.parse(line); } catch (_error) { entry = null; }
      const id = String(entry && entry.id || '').trim();
      const title = compactTitle(entry && entry.thread_name);
      if (!id || !isUsableTitle(title)) continue;
      names.set(id, {
        title,
        updatedAt: Date.parse(entry.updated_at) || 0
      });
    }
  } catch (_error) {
    return names;
  }
  return names;
}

function readInitialFileChunk(filePath, fsImpl) {
  let fd;
  try {
    const stats = fsImpl.statSync(filePath);
    const size = Math.min(Number(stats && stats.size) || 0, TITLE_SCAN_MAX_BYTES);
    if (!size) return '';
    fd = fsImpl.openSync(filePath, 'r');
    const buffer = Buffer.alloc(size);
    const bytes = fsImpl.readSync(fd, buffer, 0, size, 0);
    return buffer.toString('utf8', 0, bytes);
  } catch (_error) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch (_closeError) {}
    }
  }
}

function extractThreadTitleFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';

  if (payload.type === 'thread_goal_updated' && payload.goal && typeof payload.goal === 'object') {
    return sanitizeThreadTitle(payload.goal.objective);
  }

  if (payload.type === 'user_message') {
    return sanitizeThreadTitle(payload.message);
  }

  if (payload.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)) {
    const text = payload.content
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        if (block.type === 'input_text') return String(block.text || '');
        if (block.type === 'text') return String(block.text || '');
        return '';
      })
      .filter(Boolean)
      .join(' ');
    return sanitizeThreadTitle(text);
  }

  return '';
}

function readCodexThreadTitleFromRollout(rolloutPath, fsImpl) {
  const filePath = String(rolloutPath || '').trim();
  if (!filePath) return '';
  try {
    if (!fsImpl.existsSync(filePath)) return '';
  } catch (_error) {
    return '';
  }

  const chunk = readInitialFileChunk(filePath, fsImpl);
  if (!chunk) return '';

  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    let record = null;
    try { record = JSON.parse(line); } catch (_error) { record = null; }
    const title = extractThreadTitleFromPayload(record && record.payload);
    if (title) return title;
  }

  return extractObjectiveTitleFromText(chunk);
}

function extractCodexSessionIdFromRolloutPath(filePath) {
  const name = path.basename(String(filePath || '').trim());
  const match = name.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/);
  return match ? match[1] : '';
}

function isCodexSessionRolloutPath(filePath) {
  const text = String(filePath || '').trim();
  return text.includes('/.codex/sessions/')
    && text.endsWith('.jsonl')
    && !!extractCodexSessionIdFromRolloutPath(text);
}

function parseLsofFileNames(stdout) {
  return String(stdout || '')
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1).trim())
    .filter(isCodexSessionRolloutPath);
}

function listOpenFilesForPid(pid, options = {}) {
  const processId = Math.max(0, Math.floor(Number(pid) || 0));
  if (!processId) return [];
  if (typeof options.listOpenFilesForPid === 'function') {
    return (options.listOpenFilesForPid(processId) || [])
      .map((filePath) => String(filePath || '').trim())
      .filter(isCodexSessionRolloutPath);
  }
  if ((options.platform || process.platform) === 'win32') return [];
  const execFileSync = options.execFileSync || (() => {
    try {
      return require('node:child_process').execFileSync;
    } catch (_error) {
      return null;
    }
  })();
  if (typeof execFileSync !== 'function') return [];
  try {
    return parseLsofFileNames(execFileSync('lsof', ['-Fn', '-p', String(processId)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000
    }));
  } catch (_error) {
    return [];
  }
}

function parseProcessParentRows(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)/);
      if (!match) return null;
      return {
        pid: Number(match[1]) || 0,
        ppid: Number(match[2]) || 0
      };
    })
    .filter((row) => row && row.pid > 0);
}

function readProcessParentRows(options = {}) {
  if (typeof options.readProcessParentRows === 'function') {
    return parseProcessParentRows(
      options.readProcessParentRows()
        .map((row) => `${row.pid} ${row.ppid}`)
        .join('\n')
    );
  }
  if ((options.platform || process.platform) === 'win32') return [];
  const execFileSync = options.execFileSync || (() => {
    try {
      return require('node:child_process').execFileSync;
    } catch (_error) {
      return null;
    }
  })();
  if (typeof execFileSync !== 'function') return [];
  try {
    return parseProcessParentRows(execFileSync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000
    }));
  } catch (_error) {
    return [];
  }
}

function buildChildrenByParent(rows) {
  const byParent = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.pid || !row.ppid) continue;
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row.pid);
  }
  return byParent;
}

function collectProcessTreePids(rootPid, childrenByParent) {
  const root = Math.max(0, Math.floor(Number(rootPid) || 0));
  if (!root) return [];
  const out = [];
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const childPid of childrenByParent.get(pid) || []) {
      if (!seen.has(childPid)) queue.push(childPid);
    }
  }
  return out;
}

function chooseLatestOpenSessionFile(filePaths, fsImpl) {
  const files = Array.from(new Set(
    (Array.isArray(filePaths) ? filePaths : [])
      .map((filePath) => String(filePath || '').trim())
      .filter(isCodexSessionRolloutPath)
  ));
  if (!files.length) return '';
  return files
    .map((filePath) => {
      let mtimeMs = 0;
      try {
        mtimeMs = Number(fsImpl.statSync(filePath).mtimeMs) || 0;
      } catch (_error) {
        mtimeMs = 0;
      }
      return { filePath, mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath))[0].filePath;
}

function readActiveCodexSessionRecords(sessions, options = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const fsImpl = options.fs || require('node:fs');
  if (typeof options.readCodexActiveSessionRecords === 'function') {
    const injected = options.readCodexActiveSessionRecords(list, options);
    const byIndex = new Map();
    for (const item of Array.isArray(injected) ? injected : []) {
      const index = Number(item && item.index);
      const id = String(item && item.id || '').trim();
      const rolloutPath = String(item && item.rolloutPath || '').trim();
      if (Number.isInteger(index) && index >= 0 && (id || rolloutPath)) {
        byIndex.set(index, {
          id: id || extractCodexSessionIdFromRolloutPath(rolloutPath),
          rolloutPath
        });
      }
    }
    return byIndex;
  }
  if (!list.some((session) => Number(session && session.panePid) > 0)) return new Map();

  const rows = readProcessParentRows(options);
  const childrenByParent = buildChildrenByParent(rows);
  const byIndex = new Map();
  list.forEach((session, index) => {
    const pids = collectProcessTreePids(session && session.panePid, childrenByParent);
    const filePath = chooseLatestOpenSessionFile(
      pids.flatMap((pid) => listOpenFilesForPid(pid, options)),
      fsImpl
    );
    const id = extractCodexSessionIdFromRolloutPath(filePath);
    if (id) byIndex.set(index, { id, rolloutPath: filePath });
  });
  return byIndex;
}

function buildCodexThreadQuery(columns, projectPaths) {
  if (!columns.has('id') || !columns.has('cwd')) return null;
  const fields = [
    'id',
    'cwd',
    columns.has('title') ? 'title' : "'' AS title",
    columns.has('first_user_message') ? 'first_user_message' : "'' AS first_user_message",
    columns.has('created_at') ? 'created_at' : '0 AS created_at',
    columns.has('updated_at') ? 'updated_at' : '0 AS updated_at',
    columns.has('created_at_ms') ? 'created_at_ms' : '0 AS created_at_ms',
    columns.has('updated_at_ms') ? 'updated_at_ms' : '0 AS updated_at_ms',
    columns.has('rollout_path') ? 'rollout_path' : "'' AS rollout_path"
  ];
  const whereParts = [];
  const args = [];
  if (columns.has('archived')) whereParts.push('archived = 0');
  if (projectPaths.length) {
    const variants = Array.from(new Set(projectPaths.flatMap((projectPath) => (
      buildHostPathLookupVariants(projectPath)
    ))));
    whereParts.push(`cwd IN (${variants.map(() => '?').join(', ')})`);
    args.push(...variants);
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  return {
    sql: `SELECT ${fields.join(', ')} FROM threads ${where}`,
    args
  };
}

function readCodexThreadRecordsFromState(options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const hostHomeDir = String(options.hostHomeDir || process.env.REAL_HOME || process.env.HOME || '').trim();
  if (!hostHomeDir) return [];

  const codexDir = path.join(hostHomeDir, '.codex');
  const DatabaseSync = getDatabaseSyncCtor(options);
  if (!DatabaseSync) return [];

  const projectPaths = Array.from(new Set(
    (Array.isArray(options.projectPaths) ? options.projectPaths : [])
      .map(normalizeProjectPath)
      .filter(Boolean)
  ));
  const sessionNames = readCodexSessionNameMap(codexDir, fsImpl);

  for (const dbPath of listCodexStateDbPaths(codexDir, fsImpl)) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      if (typeof db.exec === 'function') db.exec('PRAGMA query_only = ON;');
      const query = buildCodexThreadQuery(getSqliteTableColumns(db, 'threads'), projectPaths);
      if (!query) continue;
      const rows = db.prepare(query.sql).all(...query.args);
      if (!rows.length) continue;
      return rows
        .map((row) => {
          const id = String(row && row.id || '').trim();
          const nameEntry = sessionNames.get(id);
          const rolloutPath = normalizeHostPathForLookup(row && row.rollout_path);
          const title = sanitizeThreadTitle(
            (nameEntry && nameEntry.title) || row.title || row.first_user_message
          ) || readCodexThreadTitleFromRollout(rolloutPath, fsImpl);
          if (!id || !isUsableTitle(title)) return null;
          return {
            id,
            cwd: normalizeProjectPath(row.cwd),
            title,
            createdAt: toSeconds(row.created_at_ms) || toSeconds(row.created_at),
            updatedAt: toSeconds((nameEntry && nameEntry.updatedAt) || row.updated_at_ms) || toSeconds(row.updated_at),
            rolloutPath
          };
        })
        .filter((record) => record && record.cwd);
    } catch (_error) {
      continue;
    } finally {
      if (db && typeof db.close === 'function') {
        try { db.close(); } catch (_closeError) {}
      }
    }
  }

  return [];
}

function getRecordAssignmentKey(record) {
  return String(
    record && (
      record.id
      || record.rolloutPath
      || `${record.cwd || ''}\x00${record.createdAt || ''}\x00${record.updatedAt || ''}\x00${record.title || ''}`
    ) || ''
  );
}

function assignThreadRecordsToSessions(sessions, recordsByPath) {
  const matches = [];
  const list = Array.isArray(sessions) ? sessions : [];

  list.forEach((session, sessionIndex) => {
    const projectPath = normalizeProjectPath(session && session.path);
    const records = recordsByPath.get(projectPath) || [];
    for (const record of records) {
      const match = buildThreadMatch(session, record);
      if (match) matches.push({ ...match, session, sessionIndex });
    }
  });

  matches.sort(compareThreadMatches);

  const usedSessions = new Set();
  const usedRecords = new Set();
  const assigned = new Map();
  for (const match of matches) {
    if (usedSessions.has(match.sessionIndex)) continue;
    const recordKey = getRecordAssignmentKey(match.record);
    if (recordKey && usedRecords.has(recordKey)) continue;
    usedSessions.add(match.sessionIndex);
    if (recordKey) usedRecords.add(recordKey);
    assigned.set(match.sessionIndex, match.record);
  }

  return assigned;
}

function resolveCodexAgentTitles(sessions, options = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const projectPaths = Array.from(new Set(
    list.map((session) => normalizeProjectPath(session && session.path)).filter(Boolean)
  ));
  if (!projectPaths.length) return list;

  const fsImpl = options.fs || require('node:fs');
  const records = typeof options.readCodexThreadRecords === 'function'
    ? options.readCodexThreadRecords({ ...options, projectPaths })
    : readCodexThreadRecordsFromState({ ...options, projectPaths });
  const recordsById = new Map(
    (Array.isArray(records) ? records : [])
      .map((record) => [String(record && record.id || '').trim(), record])
      .filter(([id]) => id)
  );
  const activeRecordsByIndex = readActiveCodexSessionRecords(list, {
    ...options,
    fs: fsImpl
  });
  const recordsByPath = buildThreadRecordsByPath(records);
  const assignedRecords = assignThreadRecordsToSessions(list, recordsByPath);

  return list.map((session, index) => {
    const active = activeRecordsByIndex.get(index);
    if (active && active.id) {
      const activeRecord = recordsById.get(active.id);
      const title = sanitizeThreadTitle(activeRecord && activeRecord.title)
        || readCodexThreadTitleFromRollout(active.rolloutPath, fsImpl);
      return {
        ...session,
        ...(title ? { agentTitle: title } : {}),
        agentSessionId: active.id
      };
    }

    const best = assignedRecords.get(index);
    if (!best) return session;
    return {
      ...session,
      agentTitle: best.title,
      agentSessionId: best.id
    };
  });
}

// claude：pane 标题 ↔ ~/.claude/projects/<slug>/<uuid>.jsonl 里的 ai-title 记录。
// claude 自己把「✳ 标题」写进终端标题，也把同一个标题写进会话文件头的 ai-title，
// 所以标题就是天然的绑定键；同标题多个会话时用 pane 创建时间挑最接近的那个。
// 只读文件头/尾（ai-title 在最前面，长会话也可能在尾部再写一次），不做整文件解析。
// ai-title 记录不在文件头：claude 会随着对话重写它，最后一次写在文件末尾附近。
// 从文件尾往前按块找，找到最后一条 ai-title 就停 —— 比整文件解析快两个数量级。
const CLAUDE_TITLE_CHUNK_BYTES = 256 * 1024;
const CLAUDE_TITLE_MAX_SCAN_BYTES = 4 * 1024 * 1024;
const CLAUDE_SESSION_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const CLAUDE_SESSION_START_TOLERANCE_MS = 10 * 60 * 1000;

function sanitizeClaudeProjectDirName(projectPath) {
  return String(projectPath || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function normalizeClaudeSessionTitle(value) {
  // pane 标题是「✳ 本地合并取代 AWS」，ai-title 是「本地合并取代 AWS」。
  return String(value || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
}

/**
 * 从文件尾往前找最后一条 ai-title 记录（claude 每次改标题都追加一条）。
 * 找到就返回，找不到返回空串。
 */
function readClaudeAiTitle(filePath, fsImpl, stats = null) {
  let size = Number(stats && stats.size) || 0;
  if (!size) {
    try { size = Number(fsImpl.statSync(filePath).size) || 0; } catch (_error) { return ''; }
  }
  if (!size) return '';
  let fd = null;
  try {
    fd = fsImpl.openSync(filePath, 'r');
    let end = size;
    while (end > 0 && size - end <= CLAUDE_TITLE_MAX_SCAN_BYTES) {
      const start = Math.max(0, end - CLAUDE_TITLE_CHUNK_BYTES);
      const buffer = Buffer.alloc(end - start);
      const bytes = fsImpl.readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.toString('utf8', 0, bytes);
      let index = text.lastIndexOf('"ai-title"');
      while (index >= 0) {
        const lineStart = text.lastIndexOf('\n', index) + 1;
        const lineEnd = text.indexOf('\n', index);
        if (lineEnd >= 0) {
          try {
            const record = JSON.parse(text.slice(lineStart, lineEnd));
            if (record && record.type === 'ai-title' && record.aiTitle) {
              return String(record.aiTitle).trim();
            }
          } catch (_error) { /* 半行/坏行，继续往前找 */ }
        }
        index = index > 0 ? text.lastIndexOf('"ai-title"', index - 1) : -1;
      }
      end = start;
    }
    return '';
  } catch (_error) {
    return '';
  } finally {
    if (fd !== null) {
      try { fsImpl.closeSync(fd); } catch (_error) { /* 忽略 */ }
    }
  }
}

function resolveClaudeAgentSessionIds(sessions, options = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const pending = list.filter((session) => session
    && !String(session.agentSessionId || '').trim()
    && normalizeClaudeSessionTitle(session.title));
  if (!pending.length) return list;

  const fsImpl = options.fs || require('node:fs');
  const pathImpl = options.path || path;
  const statFile = typeof options.statFile === 'function'
    ? options.statFile
    : (filePath) => fsImpl.statSync(filePath);
  const hostHome = String(options.hostHomeDir || '').trim() || getRealHome();
  const projectsRoot = pathImpl.join(hostHome, '.claude', 'projects');
  const dirNames = new Set(pending
    .map((session) => sanitizeClaudeProjectDirName(normalizeProjectPath(session.path)))
    .filter(Boolean));

  // key = <projectDir><title> → 候选会话（可能同标题多个），按 mtime 升序
  const candidatesByKey = new Map();
  const now = Date.now();
  for (const dirName of dirNames) {
    const dir = pathImpl.join(projectsRoot, dirName);
    let fileNames = [];
    try {
      fileNames = fsImpl.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    } catch (_error) {
      continue;
    }
    for (const fileName of fileNames) {
      const filePath = pathImpl.join(dir, fileName);
      let stats = null;
      try { stats = statFile(filePath); } catch (_error) { continue; }
      const mtimeMs = Number(stats && stats.mtimeMs) || 0;
      if (!mtimeMs || now - mtimeMs > CLAUDE_SESSION_LOOKBACK_MS) continue;
      const title = normalizeClaudeSessionTitle(readClaudeAiTitle(filePath, fsImpl, stats));
      if (!title) continue;
      const key = `${dirName}\x1f${title}`;
      if (!candidatesByKey.has(key)) candidatesByKey.set(key, []);
      candidatesByKey.get(key).push({
        sessionId: pathImpl.basename(fileName, '.jsonl'),
        mtimeMs,
        // 会话文件是开会话时新建的：创建时间和 pane 创建时间能对上，比 mtime 稳
        // （同标题的两个会话都在写，mtime 都是「刚刚」）。
        startMs: Number(stats && stats.birthtimeMs) || mtimeMs
      });
    }
  }
  if (!candidatesByKey.size) return list;
  for (const candidates of candidatesByKey.values()) {
    candidates.sort((left, right) => left.startMs - right.startMs);
  }

  return list.map((session) => {
    if (!session || String(session.agentSessionId || '').trim()) return session;
    const title = normalizeClaudeSessionTitle(session.title);
    if (!title) return session;
    const key = `${sanitizeClaudeProjectDirName(normalizeProjectPath(session.path))}\x1f${title}`;
    const candidates = candidatesByKey.get(key);
    if (!candidates || !candidates.length) return session;
    // 会话文件是 pane 里那条 claude 启动时建的：取「pane 创建之后最早的那个」，
    // 同标题的多个会话（后来另开的）就不会串到这个 pane 上。
    const createdMs = (Number(session.created) || 0) * 1000;
    const afterPane = createdMs
      ? candidates.find((candidate) => candidate.startMs >= createdMs - CLAUDE_SESSION_START_TOLERANCE_MS)
      : null;
    const picked = afterPane || candidates[candidates.length - 1];
    return { ...session, agentSessionId: picked.sessionId, agentSessionIdSource: 'store' };
  });
}

// cline：pane → cline 会话身份（`<data>/db/sessions.db`，cwd + 启动时间容差匹配）。
// 身份用来两件事：列表显示与 `cline history` 对齐；重启恢复用 `cline --id <id>` 续接。
// 拿不到匹配时退回注册表里已记录的 forwardArgs `--id <id>`（恢复过的 pane 靠这条
// 一路带着身份，不必重新猜）。
function resolveClineAgentTitles(sessions, options = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (!list.length) return list;
  const fsImpl = options.fs || require('node:fs');
  const pathImpl = options.path || path;
  const runtimeScope = String(
    options.runtimeScope
    || (options.runtimeTarget && options.runtimeTarget.runtimeScope)
    || ''
  ).trim();
  const dataDir = resolveClineDataDir({
    aiHomeDir: options.aiHomeDir,
    runtimeScope,
    path: pathImpl
  });
  const registryEntries = Array.isArray(options.registryEntries) ? options.registryEntries : [];
  const identityBySessionName = new Map();
  for (const entry of registryEntries) {
    const name = String(entry && entry.session || '').trim();
    if (!name) continue;
    const identity = normalizeClineSessionId(entry && entry.nativeSessionId)
      || extractClineSessionId(entry && entry.forwardArgs);
    if (identity) identityBySessionName.set(name, identity);
  }
  const records = dataDir
    ? readClineSessionRecords({
      fs: fsImpl,
      path: pathImpl,
      dataDir,
      DatabaseSync: getDatabaseSyncCtor(options)
    })
    : [];
  // 全局 1:1 认领：先给「距离最近的那对」分配，再退到次近的。
  // 顺序敏感的贪心会让两个 pane 抢同一个会话（近的那个反而拿不到），
  // 因此这里先把所有 (pane, 候选) 对按距离排序，再逐个占用。
  const pairs = [];
  list.forEach((session, index) => {
    if (!records.length) return;
    findClineSessionCandidates({
      records,
      cwd: session && session.path,
      startedAt: session && session.created
    }).forEach((candidate, rank) => {
      pairs.push({ index, rank, ...candidate });
    });
  });
  pairs.sort((left, right) => (
    left.distanceMs - right.distanceMs
    || left.rank - right.rank
    || left.index - right.index
  ));
  const claimedSessions = new Set();
  const claimedRows = new Set();
  const assigned = new Map();
  for (const pair of pairs) {
    if (claimedRows.has(pair.index) || claimedSessions.has(pair.sessionId)) continue;
    claimedRows.add(pair.index);
    claimedSessions.add(pair.sessionId);
    assigned.set(pair.index, pair);
  }

  return list.map((session, index) => {
    const name = String(session && session.name || '').trim();
    const match = assigned.get(index);
    if (match) {
      return {
        ...session,
        ...(match.title ? { agentTitle: match.title } : {}),
        agentSessionId: match.sessionId,
        // 来源=会话库：可以被写回注册表（供重启恢复使用）。
        agentSessionIdSource: 'store'
      };
    }
    // 没匹配上时退回注册表里已记录的 `--id <id>`（恢复过的 pane 靠它一路带着身份）；
    // 这一路只用于显示，不再写回，避免把别人的身份复制到本 pane。
    const identity = identityBySessionName.get(name) || '';
    if (!identity) return session;
    return {
      ...session,
      agentSessionId: identity,
      agentSessionIdSource: 'registry'
    };
  });
}

// 每个 provider 自己的「pane → 原生会话身份/标题」解析器。新增 provider 只加一条，
// 调用方（持久会话列表）不认识任何 provider 名。
const AGENT_SESSION_TITLE_RESOLVERS = Object.freeze({
  codex: resolveCodexAgentTitles,
  cline: resolveClineAgentTitles
});

// 只补「原生会话 id」、不解析标题的轻量解析器：快速路径（skipAgentTitles）也能用，
// 因为会话ID 是列表的固定列，不能因为省时间就整列空着。
const AGENT_SESSION_ID_RESOLVERS = Object.freeze({
  claude: resolveClaudeAgentSessionIds
});

function resolveAgentSessionIds(cliName, sessions, options = {}) {
  const resolver = AGENT_SESSION_ID_RESOLVERS[String(cliName || '').trim().toLowerCase()];
  return resolver ? resolver(sessions, options) : sessions;
}

function resolveAgentSessionTitles(cliName, sessions, options = {}) {
  const key = String(cliName || '').trim().toLowerCase();
  const resolver = AGENT_SESSION_TITLE_RESOLVERS[key];
  if (resolver) return resolver(sessions, options);
  // 没有标题解析器也不代表没有会话身份：至少把 id 补上。
  return resolveAgentSessionIds(key, sessions, options);
}

module.exports = {
  normalizeProjectPath,
  chooseBestThreadForSession,
  readCodexThreadRecordsFromState,
  resolveAgentSessionTitles,
  resolveAgentSessionIds
};
