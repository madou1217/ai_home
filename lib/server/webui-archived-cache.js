'use strict';

const path = require('node:path');
const {
  resolveCacheDeps,
  ensureCacheStateBucket,
  readCacheJson,
  writeCacheJson
} = require('./webui-cache-store');
const {
  createSnapshotCacheState,
  ensureSnapshotLoaded,
  commitSnapshot
} = require('./webui-snapshot-state');
const {
  runSingleFlightRefresh,
  getSnapshotWithRefresh,
  scheduleDirtyRefresh,
  ensurePeriodicRefresh
} = require('./webui-cache-scheduler');

const ARCHIVED_SNAPSHOT_TTL_MS = 30_000;
const ARCHIVED_REFRESH_INTERVAL_MS = 15_000;
const ARCHIVED_SNAPSHOT_FILE = 'webui-archived-snapshot.json';

function cloneArchivedItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({ ...item }));
}

function sortArchivedItems(items) {
  return [...(Array.isArray(items) ? items : [])].sort((left, right) => {
    const rightArchivedAt = Number(right && right.archivedAt) || 0;
    const leftArchivedAt = Number(left && left.archivedAt) || 0;
    return rightArchivedAt - leftArchivedAt;
  });
}

function getArchivedCacheState(state) {
  return ensureCacheStateBucket(state, '__webUiArchivedCache', createSnapshotCacheState);
}

function readArchivedSnapshotFromDisk(deps = {}) {
  const parsed = readCacheJson(deps, ARCHIVED_SNAPSHOT_FILE);
  if (!parsed) return null;
  return {
    revision: Number(parsed && parsed.revision) || 0,
    updatedAt: Number(parsed && parsed.updatedAt) || 0,
    snapshot: cloneArchivedItems(parsed && parsed.archived)
  };
}

function writeArchivedSnapshotToDisk(cacheState, deps = {}) {
  writeCacheJson(deps, ARCHIVED_SNAPSHOT_FILE, {
    revision: Number(cacheState.revision) || 0,
    updatedAt: Number(cacheState.updatedAt) || 0,
    archived: cacheState.snapshot
  });
}

function ensureArchivedSnapshotLoaded(ctx) {
  const cacheState = getArchivedCacheState(ctx.state);
  return ensureSnapshotLoaded(cacheState, () => readArchivedSnapshotFromDisk(ctx));
}

function buildArchivedSnapshot(ctx) {
  const { getRealHome } = require('../sessions/session-reader');
  const { fs } = resolveCacheDeps(ctx);
  const hostHome = getRealHome();
  const archived = [];

  try {
    const archivedDir = path.join(hostHome, '.codex', 'archived_sessions');
    if (fs.existsSync(archivedDir)) {
      let sessionIndexLines = null;
      const indexPath = path.join(hostHome, '.codex', 'session_index.jsonl');
      if (fs.existsSync(indexPath)) {
        sessionIndexLines = fs.readFileSync(indexPath, 'utf8').split('\n').filter((line) => line.trim());
      }
      for (const entry of fs.readdirSync(archivedDir, { withFileTypes: true })) {
        if (!entry.name.endsWith('.jsonl')) continue;
        const filePath = path.join(archivedDir, entry.name);
        const uuidMatch = entry.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (!uuidMatch) continue;
        const sessionId = uuidMatch[1];
        const stats = fs.statSync(filePath);
        let title = '未命名会话';
        if (Array.isArray(sessionIndexLines)) {
          for (const line of sessionIndexLines) {
            try {
              const item = JSON.parse(line);
              if (item.id === sessionId && item.thread_name) {
                title = item.thread_name;
                break;
              }
            } catch (_error) {}
          }
        }
        archived.push({ id: sessionId, title, provider: 'codex', archivedAt: stats.mtimeMs });
      }
    }
  } catch (_error) {}

  try {
    const claudeProjectsDir = path.join(hostHome, '.claude', 'projects');
    if (fs.existsSync(claudeProjectsDir)) {
      for (const projectDirName of fs.readdirSync(claudeProjectsDir)) {
        const archivedDir = path.join(claudeProjectsDir, projectDirName, '.archived');
        if (!fs.existsSync(archivedDir)) continue;
        for (const fileName of fs.readdirSync(archivedDir).filter((item) => item.endsWith('.jsonl'))) {
          const sessionId = fileName.replace('.jsonl', '');
          const filePath = path.join(archivedDir, fileName);
          const stats = fs.statSync(filePath);
          let title = '未命名会话';
          try {
            const fd = fs.openSync(filePath, 'r');
            try {
              const buf = Buffer.alloc(16384);
              const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
              const chunk = buf.toString('utf8', 0, bytesRead);
              const lines = chunk.split('\n').filter((line) => line.trim());
              for (const line of lines) {
                try {
                  const record = JSON.parse(line);
                  if (record.type !== 'user' || !record.message || !record.message.content) continue;
                  let text = '';
                  if (typeof record.message.content === 'string') text = record.message.content;
                  else if (Array.isArray(record.message.content)) {
                    text = record.message.content
                      .filter((block) => block.type === 'text')
                      .map((block) => block.text)
                      .join(' ');
                  }
                  if (
                    text
                    && !text.startsWith('Caveat:')
                    && !text.startsWith('<command-name>')
                    && !text.startsWith('<local-command')
                    && !text.startsWith('<ide_opened_file>')
                  ) {
                    title = text.slice(0, 50);
                    break;
                  }
                } catch (_error) {}
              }
            } finally {
              fs.closeSync(fd);
            }
          } catch (_error) {}
          archived.push({ id: sessionId, title, provider: 'claude', projectDirName, archivedAt: stats.mtimeMs });
        }
      }
    }
  } catch (_error) {}

  try {
    const tmpDir = path.join(hostHome, '.gemini', 'tmp');
    if (fs.existsSync(tmpDir)) {
      for (const projectDirName of fs.readdirSync(tmpDir)) {
        const archivedDir = path.join(tmpDir, projectDirName, 'chats', '.archived');
        if (!fs.existsSync(archivedDir)) continue;
        for (const fileName of fs.readdirSync(archivedDir).filter((item) => item.endsWith('.json'))) {
          try {
            const chatPath = path.join(archivedDir, fileName);
            const data = JSON.parse(fs.readFileSync(chatPath, 'utf8'));
            const sessionId = data.sessionId || fileName.replace('.json', '');
            let title = data.summary || '';
            if (!title && Array.isArray(data.messages) && data.messages.length > 0) {
              const firstUser = data.messages.find((message) => message.type === 'user');
              if (firstUser && firstUser.content) {
                const textBlock = Array.isArray(firstUser.content)
                  ? firstUser.content.find((content) => content.text)
                  : firstUser.content;
                title = (typeof textBlock === 'string' ? textBlock : textBlock?.text || '').slice(0, 50);
              }
            }
            archived.push({
              id: sessionId,
              title: title || '未命名会话',
              provider: 'gemini',
              projectDirName,
              archivedAt: fs.statSync(chatPath).mtimeMs
            });
          } catch (_error) {}
        }
      }
    }
  } catch (_error) {}

  return sortArchivedItems(archived);
}

async function refreshArchivedSnapshot(ctx) {
  const cacheState = ensureArchivedSnapshotLoaded(ctx);
  return runSingleFlightRefresh(cacheState, async () => {
    commitSnapshot(cacheState, cloneArchivedItems(buildArchivedSnapshot(ctx)), (nextState) => {
      writeArchivedSnapshotToDisk(nextState, ctx);
    });
    return cacheState;
  });
}

function shouldRefreshArchivedSnapshot(cacheState, options = {}) {
  if (options.forceRefresh) return true;
  if (!cacheState.updatedAt) return true;
  if (cacheState.dirty) return true;
  return (Date.now() - Number(cacheState.lastRefreshAt || 0)) >= ARCHIVED_SNAPSHOT_TTL_MS;
}

async function getArchivedSnapshot(ctx, options = {}) {
  const cacheState = ensureArchivedSnapshotLoaded(ctx);
  await getSnapshotWithRefresh(cacheState, options, {
    shouldRefresh: shouldRefreshArchivedSnapshot,
    refresh: () => refreshArchivedSnapshot(ctx)
  });
  return {
    revision: Number(cacheState.revision) || 0,
    updatedAt: Number(cacheState.updatedAt) || 0,
    archived: cloneArchivedItems(cacheState.snapshot)
  };
}

function scheduleArchivedSnapshotRefresh(ctx) {
  const cacheState = ensureArchivedSnapshotLoaded(ctx);
  scheduleDirtyRefresh(cacheState, () => refreshArchivedSnapshot(ctx));
}

function setArchivedSnapshot(ctx, nextItems) {
  const cacheState = ensureArchivedSnapshotLoaded(ctx);
  commitSnapshot(cacheState, sortArchivedItems(cloneArchivedItems(nextItems)), (nextState) => {
    writeArchivedSnapshotToDisk(nextState, ctx);
  });
  return {
    revision: cacheState.revision,
    updatedAt: cacheState.updatedAt,
    archived: cloneArchivedItems(cacheState.snapshot)
  };
}

function updateArchivedSnapshot(ctx, updater) {
  const cacheState = ensureArchivedSnapshotLoaded(ctx);
  const currentItems = cloneArchivedItems(cacheState.snapshot);
  const nextItems = typeof updater === 'function' ? updater(currentItems) : currentItems;
  return setArchivedSnapshot(ctx, nextItems);
}

function ensureArchivedSnapshotScheduler(ctx) {
  const cacheState = ensureArchivedSnapshotLoaded(ctx);
  ensurePeriodicRefresh(cacheState, {
    shouldRefresh: shouldRefreshArchivedSnapshot,
    refresh: () => refreshArchivedSnapshot(ctx),
    intervalMs: ARCHIVED_REFRESH_INTERVAL_MS,
    warmupMs: 1000
  });
}

module.exports = {
  getArchivedSnapshot,
  refreshArchivedSnapshot,
  scheduleArchivedSnapshotRefresh,
  updateArchivedSnapshot,
  ensureArchivedSnapshotScheduler
};
