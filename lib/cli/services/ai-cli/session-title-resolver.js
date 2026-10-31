'use strict';

const path = require('node:path');
const osImpl = require('node:os');
const {
  buildHostPathLookupVariants,
  normalizeHostPathForLookup
} = require('../../../runtime/windows-path-encoding');
const { getRealHome } = require('../../../sessions/session-reader-utils');
const { listFamilySessionRoots } = require('../../../runtime/codebuddy-family-session-store');
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

// pane 标题带 spinner 前缀（⠧ 在跑 / ⠹ 空闲）时，展示层会整条丢掉、只剩项目名。
// 这种行才需要用会话库里的标题补；已经可用的 pane 标题（如 claude 的 ✳ …）保持原样。
function isUsablePaneTitle(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return !/^[\u2800-\u28ff]\s+\S+/.test(text);
}

function isSyntheticThreadTitle(value) {
  const title = compactTitle(value);
  return title.startsWith('# AGENTS.md instructions')
    || title.startsWith('<codex_internal_context')
    || title.startsWith('<environment_context')
    || title.startsWith('<goal_context')
    // gemini 的「标题」其实是首条消息里的上下文块，不能当标题展示。
    || title.startsWith('<session_context')
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

// ---- pane → harness 原生会话 id（通用） ----
// 每个 provider 只描述「会话存在哪、标题怎么读」，匹配逻辑共用：
//   1) 标题能对上（pane 标题 = 会话标题）→ 用标题；
//   2) 对不上 → 同项目下「pane 创建之后最早开始」的那个会话。
// 候选统一按会话开始时间排序，所以同项目多个 pane 不会抢同一个会话。
const SESSION_STORE_TITLE_CHUNK_BYTES = 256 * 1024;
const SESSION_STORE_TITLE_MAX_SCAN_BYTES = 4 * 1024 * 1024;
const SESSION_STORE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_STORE_START_TOLERANCE_MS = 10 * 60 * 1000;

// 各 harness 的目录名规则并不统一：claude 把分隔符换成 `-`（保留前导 `-`、`_` 也变 `-`），
// codebuddy 家族去掉前导分隔符、保留 `_`。别猜规则——按「去掉所有非字母数字后相同」对目录，
// 哪边改了命名口径都不会漏。
function canonicalProjectDirKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function listProjectStoreDirs(projectsRoot, projectPath, fsImpl, pathImpl) {
  const wanted = canonicalProjectDirKey(projectPath);
  if (!wanted) return [];
  let entries = [];
  try {
    entries = fsImpl.readdirSync(projectsRoot, { withFileTypes: true });
  } catch (_error) {
    try {
      entries = fsImpl.readdirSync(projectsRoot).map((name) => ({ name, isDirectory: () => true }));
    } catch (_error2) {
      return [];
    }
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry) continue;
    const name = String(entry.name || '');
    if (!name) continue;
    if (typeof entry.isDirectory === 'function' && !entry.isDirectory()) continue;
    if (canonicalProjectDirKey(name) !== wanted) continue;
    dirs.push(pathImpl.join(projectsRoot, name));
  }
  return dirs;
}

function normalizeSessionStoreTitle(value) {
  // pane 标题是「✳ 本地合并取代 AWS」，会话标题是「本地合并取代 AWS」。
  return String(value || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
}

/**
 * 从文件尾往前找最后一条 ai-title（claude/codebuddy 每改一次标题就追加一条）。
 * 找不到返回空串。
 */
function readJsonlLastTitle(filePath, fsImpl, stats = null) {
  let size = Number(stats && stats.size) || 0;
  if (!size) {
    try { size = Number(fsImpl.statSync(filePath).size) || 0; } catch (_error) { return ''; }
  }
  if (!size) return '';
  let fd = null;
  try {
    fd = fsImpl.openSync(filePath, 'r');
    let end = size;
    while (end > 0 && size - end <= SESSION_STORE_TITLE_MAX_SCAN_BYTES) {
      const start = Math.max(0, end - SESSION_STORE_TITLE_CHUNK_BYTES);
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

/** claude / codebuddy 家族：<root>/<project-slug>/<uuid>.jsonl */
function readJsonlStoreCandidates(projectsRoot, projectPath, context) {
  const { fsImpl, pathImpl, statFile, now } = context;
  const out = [];
  for (const dir of listProjectStoreDirs(projectsRoot, projectPath, fsImpl, pathImpl)) {
    let fileNames = [];
    try {
      fileNames = fsImpl.readdirSync(dir).filter((name) => String(name).endsWith('.jsonl'));
    } catch (_error) {
      continue;
    }
    for (const fileName of fileNames) {
      const filePath = pathImpl.join(dir, fileName);
      let stats = null;
      try { stats = statFile(filePath); } catch (_error) { continue; }
      const mtimeMs = Number(stats && stats.mtimeMs) || 0;
      if (!mtimeMs || now - mtimeMs > SESSION_STORE_LOOKBACK_MS) continue;
      out.push({
        id: pathImpl.basename(fileName, '.jsonl'),
        title: readJsonlLastTitle(filePath, fsImpl, stats),
        // 会话文件是开会话时新建的：创建时间比 mtime 稳（同标题两个会话都在写，mtime 都「刚刚」）
        startMs: Number(stats && stats.birthtimeMs) || mtimeMs,
        mtimeMs
      });
    }
  }
  return out;
}

/** kiro：~/.kiro/sessions/<group>/sess_xxx/session.json（workspacePaths + createdAt） */
function readKiroStoreCandidates(hostHome, projectPath, context) {
  const { fsImpl, pathImpl, now } = context;
  const root = pathImpl.join(hostHome, '.kiro', 'sessions');
  const wanted = normalizeProjectPath(projectPath);
  if (!wanted) return [];
  let groups = [];
  try {
    groups = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
  const out = [];
  for (const group of groups) {
    if (!group || typeof group.isDirectory !== 'function' || !group.isDirectory()) continue;
    const groupDir = pathImpl.join(root, group.name);
    let entries = [];
    try {
      entries = fsImpl.readdirSync(groupDir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      if (!entry || typeof entry.isDirectory !== 'function' || !entry.isDirectory()) continue;
      const sessionId = String(entry.name || '');
      if (!sessionId.startsWith('sess_')) continue;
      const sessionDir = pathImpl.join(groupDir, sessionId);
      let meta = null;
      try {
        meta = JSON.parse(fsImpl.readFileSync(pathImpl.join(sessionDir, 'session.json'), 'utf8'));
      } catch (_error) {
        meta = null;
      }
      if (!meta) continue;
      const workspace = String((Array.isArray(meta.workspacePaths) ? meta.workspacePaths[0] : '') || '').trim();
      if (normalizeProjectPath(workspace) !== wanted) continue;
      let mtimeMs = 0;
      try { mtimeMs = Number(fsImpl.statSync(pathImpl.join(sessionDir, 'messages.jsonl')).mtimeMs) || 0; } catch (_error) { mtimeMs = 0; }
      if (!mtimeMs) {
        try { mtimeMs = Number(fsImpl.statSync(sessionDir).mtimeMs) || 0; } catch (_error) { mtimeMs = 0; }
      }
      if (!mtimeMs || now - mtimeMs > SESSION_STORE_LOOKBACK_MS) continue;
      const startMs = Date.parse(String(meta.createdAt || '')) || mtimeMs;
      out.push({ id: sessionId, title: String(meta.title || '').trim(), startMs, mtimeMs });
    }
  }
  return out;
}

// pane 创建之前就开好的会话（续接场景）只接受半天内的：再老就不是这个 pane 的会话了，
// 宁可留空，也不能把十天前的老会话贴到新 pane 上——错的 id 比没有 id 更糟。
const SESSION_STORE_BEFORE_PANE_MAX_MS = 12 * 60 * 60 * 1000;

/**
 * 候选与 pane 的匹配分：
 *   rank 0 标题对上（最可信）
 *   rank 1 pane 创建之后开始（新建会话的正常情况）
 *   rank 2 早于 pane 但仍在半天内（续接/恢复的会话）
 * 返回 null 表示这条候选跟这个 pane 无关。
 */
function scoreStoreCandidate(candidate, session) {
  const createdMs = (Number(session && session.created) || 0) * 1000;
  const title = normalizeSessionStoreTitle(session && session.title);
  if (title && candidate.title && normalizeSessionStoreTitle(candidate.title) === title) {
    return { rank: 0, delta: createdMs ? Math.abs(candidate.startMs - createdMs) : 0 };
  }
  // 候选自己没有任何时间信息（部分 sqlite provider 的行 time_created 为 0）：
  // 只能靠标题认，按时间排它会稳赢（0 比谁都「早」）。
  if (!(Number(candidate.startMs) > 0) && !(Number(candidate.mtimeMs) > 0)) return null;
  // 没有 pane 创建时间就没法按时间对，只认标题；乱猜一个 id 比空着更糟。
  if (!createdMs) return null;
  // 有些 provider（qoder / agy / grok）没有会话开始时间，只有最后活动时间。
  // 对它们「离 pane 创建时间最近」是错的：pane 活了一整天，会话的最后活动就是刚刚。
  // 这类候选按「最近活动优先」排。
  if (candidate.approxStart) {
    const touchedMs = Number(candidate.mtimeMs) || candidate.startMs;
    if (touchedMs >= createdMs - SESSION_STORE_START_TOLERANCE_MS) return { rank: 1, delta: -touchedMs };
    return { rank: 2, delta: createdMs - touchedMs };
  }
  const offset = candidate.startMs - createdMs;
  // 时间容差内的都算「新建会话」：取绝对距离，否则早开 3 分钟的会排在后开 2 分钟的前面。
  if (offset >= -SESSION_STORE_START_TOLERANCE_MS) return { rank: 1, delta: Math.abs(offset) };
  if (-offset <= SESSION_STORE_BEFORE_PANE_MAX_MS) return { rank: 2, delta: -offset };
  return null;
}

/**
 * 把 pane 绑定到会话库里的会话。
 *
 * 全局 1:1 认领：同一项目的两个 pane 如果各自挑「最像的那个」，很容易挑到同一个会话。
 * 所以先把所有 (pane, 候选) 对按匹配分排序，再逐个占用——最像的那对先拿到，
 * 剩下的 pane 只能在没被占用的候选里挑。
 */
function bindSessionsToStore(sessions, candidatesForProject) {
  const list = Array.isArray(sessions) ? sessions : [];
  const needsId = (session) => Boolean(session) && !String(session.agentSessionId || '').trim();
  // 已经有 id 的行（注册表 / 缓存给的）也要补标题：pane 标题常带 spinner 前缀被展示层丢掉。
  const needsTitle = (session) => Boolean(session)
    && Boolean(String(session.agentSessionId || '').trim())
    && !String(session.agentTitle || '').trim();
  if (!list.some((session) => needsId(session) || needsTitle(session))) return list;
  const cache = new Map();
  const candidatesFor = (projectPath) => {
    const key = normalizeProjectPath(projectPath);
    if (!key) return [];
    if (!cache.has(key)) {
      let candidates = [];
      try { candidates = candidatesForProject(key) || []; } catch (_error) { candidates = []; }
      cache.set(key, candidates);
    }
    return cache.get(key);
  };
  const pairs = [];
  list.forEach((session, index) => {
    if (!session || String(session.agentSessionId || '').trim()) return;
    for (const candidate of candidatesFor(session.path)) {
      if (!candidate || !candidate.id) continue;
      const score = scoreStoreCandidate(candidate, session);
      if (!score) continue;
      pairs.push({ index, candidate, rank: score.rank, delta: score.delta });
    }
  });
  pairs.sort((left, right) => (
    left.rank - right.rank
    || left.delta - right.delta
    || left.index - right.index
  ));
  const claimedRows = new Set();
  const claimedIds = new Set();
  const assigned = new Map();
  for (const pair of pairs) {
    if (claimedRows.has(pair.index) || claimedIds.has(pair.candidate.id)) continue;
    claimedRows.add(pair.index);
    claimedIds.add(pair.candidate.id);
    assigned.set(pair.index, pair.candidate);
  }
  // 已经有 id 的行按 id 反查标题（候选已经在上面按项目读过了）。
  const titleById = new Map();
  if (list.some(needsTitle)) {
    for (const session of list) {
      for (const candidate of candidatesFor(session && session.path)) {
        if (!candidate || !candidate.id || !candidate.title) continue;
        if (!titleById.has(candidate.id)) titleById.set(candidate.id, candidate.title);
      }
    }
  }
  return list.map((session, index) => {
    const picked = assigned.get(index);
    // 顺手带上会话库里的标题：pane 标题常带 spinner 前缀（⠧ …），展示层会把它丢掉，
    // 最后只剩项目名。会话库里的 ai-title / summary 是干净的。
    const rawTitle = picked ? picked.title : titleById.get(String(session && session.agentSessionId || '').trim());
    const title = compactTitle(rawTitle);
    const next = picked
      ? { ...session, agentSessionId: picked.id, agentSessionIdSource: 'store' }
      : session;
    if (!title || isSyntheticThreadTitle(title)) return next;
    if (String(session.agentTitle || '').trim() || isUsablePaneTitle(session.title)) return next;
    return { ...next, agentTitle: title };
  });
}

/**
 * 会话库要按哪些宿主目录找。
 *
 * 正常情况就是 HOME。但 HOME 会被账号投影改写：在 agent 里跑 `aih ss` 时 HOME 指向
 * `run/auth-projections/<provider>/<acct>`，那里只有投影的配置目录，宿主自己的会话库
 * 还在真实用户目录下——只认 HOME 会让「会话ID」整列变成 `—`。所以把真实用户目录
 * 也列进来当兜底（只在当前目录读不到东西时才用）。
 */
function sessionStoreHomes(options = {}) {
  const homes = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text && !homes.includes(text)) homes.push(text);
  };
  push(options.hostHomeDir);
  push(getRealHome());
  try { push(osImpl.userInfo().homedir); } catch (_error) { /* 忽略 */ }
  try { push(osImpl.homedir()); } catch (_error) { /* 忽略 */ }
  return homes;
}

/** 依次在候选宿主目录里读，读到东西就停（兜底目录只在主目录空的时候才用）。 */
function readAcrossHomes(homes, readForHome) {
  for (const home of homes) {
    let out = [];
    try { out = readForHome(home) || []; } catch (_error) { out = []; }
    if (out.length) return out;
  }
  return [];
}

function sessionStoreContext(options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const homes = sessionStoreHomes(options);
  return {
    fsImpl,
    pathImpl: options.path || path,
    statFile: typeof options.statFile === 'function'
      ? options.statFile
      : (filePath) => fsImpl.statSync(filePath),
    hostHomes: homes,
    hostHome: homes[0] || '',
    now: Date.now()
  };
}

/** claude：~/.claude/projects/<slug>/<uuid>.jsonl（ai-title 当绑定键） */
function resolveClaudeAgentSessionIds(sessions, options = {}) {
  const context = sessionStoreContext(options);
  return bindSessionsToStore(
    sessions,
    (projectPath) => readAcrossHomes(context.hostHomes, (home) => (
      readJsonlStoreCandidates(context.pathImpl.join(home, '.claude', 'projects'), projectPath, context)
    ))
  );
}

/** codebuddy 家族（codebuddy / codebuddycn / workbuddy*）：<config>/projects/<slug>/<uuid>.jsonl */
function resolveCodebuddyAgentSessionIds(sessions, options = {}) {
  const context = sessionStoreContext(options);
  return bindSessionsToStore(
    sessions,
    (projectPath) => readAcrossHomes(context.hostHomes, (home) => (
      listFamilySessionRoots(home)
        .flatMap((root) => readJsonlStoreCandidates(root.projectsRoot, projectPath, context))
    ))
  );
}

/** kiro：~/.kiro/sessions/<group>/sess_xxx/session.json（session.json 自带 title） */
function resolveKiroAgentSessionIds(sessions, options = {}) {
  const context = sessionStoreContext(options);
  return bindSessionsToStore(
    sessions,
    (projectPath) => readAcrossHomes(context.hostHomes, (home) => (
      readKiroStoreCandidates(home, projectPath, context)
    ))
  );
}

/**
 * 其余 provider（grok / gemini / agy / zcode / opencode / qoder / qodercn）：
 * 直接复用会话层「按 provider 读项目会话」的实现，只取当前项目那一条。
 * 这些 reader 单次 1~60ms；claude / codebuddy 走上面的专用读法（全量扫描要 300ms+）。
 */
function readHostProjectCandidates(provider, projectPath, context) {
  const { readProjectsFromHostByProviders } = require('../../../sessions/session-reader');
  const wanted = normalizeProjectPath(projectPath);
  const out = [];
  const projects = readAcrossHomes(context.hostHomes, (home) => (
    readProjectsFromHostByProviders([provider], { hostHomeDir: home }) || []
  ).filter((project) => normalizeProjectPath(project && project.path) === wanted));
  for (const project of projects) {
    if (normalizeProjectPath(project && project.path) !== wanted) continue;
    for (const session of (project && project.sessions) || []) {
      const id = String((session && session.id) || '').trim();
      if (!id) continue;
      const createdMs = Number(session.createdAt) || 0;
      const updatedMs = Number(session.updatedAt) || createdMs;
      out.push({
        id,
        title: String((session && session.title) || ''),
        startMs: createdMs || updatedMs,
        mtimeMs: updatedMs,
        // 没有 createdAt 的 provider 只有「最后活动时间」，不能当开始时间用。
        approxStart: !createdMs
      });
    }
  }
  return out;
}

function resolveHostProjectAgentSessionIds(provider) {
  return function resolveHostProjectIds(sessions, options = {}) {
    const context = sessionStoreContext(options);
    return bindSessionsToStore(
      sessions,
      (projectPath) => readHostProjectCandidates(provider, projectPath, context)
    );
  };
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
  claude: resolveClaudeAgentSessionIds,
  codebuddy: resolveCodebuddyAgentSessionIds,
  codebuddycn: resolveCodebuddyAgentSessionIds,
  workbuddy: resolveCodebuddyAgentSessionIds,
  workbuddycn: resolveCodebuddyAgentSessionIds,
  kiro: resolveKiroAgentSessionIds,
  qoder: resolveHostProjectAgentSessionIds('qoder'),
  qodercn: resolveHostProjectAgentSessionIds('qodercn'),
  grok: resolveHostProjectAgentSessionIds('grok'),
  gemini: resolveHostProjectAgentSessionIds('gemini'),
  agy: resolveHostProjectAgentSessionIds('agy'),
  zcode: resolveHostProjectAgentSessionIds('zcode'),
  opencode: resolveHostProjectAgentSessionIds('opencode')
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
