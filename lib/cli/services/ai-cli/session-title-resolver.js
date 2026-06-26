'use strict';

const path = require('node:path');

const TITLE_MAX_LENGTH = 120;
const SESSION_MATCH_TOLERANCE_SECONDS = 10;
const TITLE_SCAN_MAX_BYTES = 1024 * 1024;

function normalizeProjectPath(value) {
  const text = String(value || '').trim();
  return text ? text.replace(/\/+$/, '') : '';
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
    whereParts.push(`cwd IN (${projectPaths.map(() => '?').join(', ')})`);
    args.push(...projectPaths);
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
          const rolloutPath = String(row && row.rollout_path || '').trim();
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

function resolveAgentSessionTitles(cliName, sessions, options = {}) {
  if (String(cliName || '').trim().toLowerCase() !== 'codex') return sessions;
  return resolveCodexAgentTitles(sessions, options);
}

module.exports = {
  normalizeProjectPath,
  chooseBestThreadForSession,
  readCodexThreadRecordsFromState,
  resolveAgentSessionTitles
};
