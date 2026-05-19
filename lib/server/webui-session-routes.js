'use strict';

const path = require('node:path');
const { refreshProjectsSnapshot } = require('./webui-project-cache');
const {
  getArchivedSnapshot,
  scheduleArchivedSnapshotRefresh,
  updateArchivedSnapshot
} = require('./webui-archived-cache');

async function handleGetAccountSessionsRequest(ctx) {
  const {
    pathname,
    getProfileDir,
    writeJson
  } = ctx;

  const matches = pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)$/);
  const provider = matches[1];
  const accountId = matches[2];

  try {
    const { readAccountSessions } = require('../sessions/session-reader');
    const profileDir = getProfileDir(provider, accountId);
    const projects = readAccountSessions(provider, profileDir);
    writeJson(ctx.res, 200, { ok: true, projects });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'get_sessions_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleGetSessionMessagesRequest(ctx) {
  const {
    pathname,
    req,
    writeJson
  } = ctx;

  const matches = pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)\/messages$/);
  const provider = matches[1];
  const sessionId = matches[2];

  try {
    const { readSessionMessages, getSessionFileCursor } = require('../sessions/session-reader');
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const projectDirName = requestUrl.searchParams.get('projectDirName');
    const messages = readSessionMessages(provider, { sessionId, projectDirName });
    const cursor = getSessionFileCursor(provider, { sessionId, projectDirName });
    writeJson(ctx.res, 200, { ok: true, messages, cursor });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'get_messages_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleGetSessionEventsRequest(ctx) {
  const {
    pathname,
    req,
    writeJson
  } = ctx;

  const matches = pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)\/events$/);
  const provider = matches[1];
  const sessionId = matches[2];

  try {
    const { readSessionEvents } = require('../sessions/session-reader');
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const projectDirName = requestUrl.searchParams.get('projectDirName');
    const cursor = Number(requestUrl.searchParams.get('cursor') || 0);
    const payload = readSessionEvents(provider, { sessionId, projectDirName }, { cursor });
    writeJson(ctx.res, 200, { ok: true, ...payload });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'get_session_events_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleArchiveSessionRequest(ctx) {
  const {
    readRequestBody,
    fs,
    writeJson
  } = ctx;

  const payload = await readRequestBody(ctx.req, { maxBytes: 1024 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);

  if (!payload || !payload.provider || !payload.sessionId) {
    writeJson(ctx.res, 400, { ok: false, error: 'missing_params' });
    return true;
  }

  try {
    const { provider, sessionId, projectDirName } = payload;
    const { getRealHome } = require('../sessions/session-reader');
    const hostHome = getRealHome();

    if (provider === 'codex') {
      const sessionsDir = path.join(hostHome, '.codex', 'sessions');
      const archivedDir = path.join(hostHome, '.codex', 'archived_sessions');
      if (!fs.existsSync(archivedDir)) fs.mkdirSync(archivedDir, { recursive: true });

      const findFile = (dir) => {
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              const nested = findFile(fullPath);
              if (nested) return nested;
            } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
              return fullPath;
            }
          }
        } catch (_error) {}
        return null;
      };

      const filePath = findFile(sessionsDir);
      if (filePath) {
        fs.renameSync(filePath, path.join(archivedDir, path.basename(filePath)));
      }
    } else if (provider === 'claude') {
      if (!projectDirName) {
        writeJson(ctx.res, 400, { ok: false, error: 'missing_projectDirName' });
        return true;
      }
      const projectDir = path.join(hostHome, '.claude', 'projects', projectDirName);
      const archivedDir = path.join(projectDir, '.archived');
      const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);
      if (fs.existsSync(sessionFile)) {
        if (!fs.existsSync(archivedDir)) fs.mkdirSync(archivedDir, { recursive: true });
        fs.renameSync(sessionFile, path.join(archivedDir, `${sessionId}.jsonl`));
      }
    } else if (provider === 'gemini') {
      if (!projectDirName) {
        writeJson(ctx.res, 400, { ok: false, error: 'missing_projectDirName' });
        return true;
      }
      const chatsDir = path.join(hostHome, '.gemini', 'tmp', projectDirName, 'chats');
      const archivedDir = path.join(chatsDir, '.archived');
      if (fs.existsSync(chatsDir)) {
        for (const fileName of fs.readdirSync(chatsDir).filter((item) => item.endsWith('.json'))) {
          try {
            const chatPath = path.join(chatsDir, fileName);
            const data = JSON.parse(fs.readFileSync(chatPath, 'utf8'));
            if (data.sessionId === sessionId || fileName.replace('.json', '') === sessionId) {
              if (!fs.existsSync(archivedDir)) fs.mkdirSync(archivedDir, { recursive: true });
              fs.renameSync(chatPath, path.join(archivedDir, fileName));
              break;
            }
          } catch (_error) {}
        }
      }
    }

    updateArchivedSnapshot(ctx, (items) => {
      const nextItems = Array.isArray(items) ? items.slice() : [];
      const existingIndex = nextItems.findIndex((item) => (
        item.provider === provider
        && item.id === sessionId
        && String(item.projectDirName || '') === String(projectDirName || '')
      ));
      const nextItem = {
        id: sessionId,
        title: String(payload.title || '').trim() || '未命名会话',
        provider,
        projectDirName: projectDirName || undefined,
        archivedAt: Date.now()
      };
      if (existingIndex >= 0) {
        nextItems[existingIndex] = {
          ...nextItems[existingIndex],
          ...nextItem
        };
        return nextItems;
      }
      nextItems.unshift(nextItem);
      return nextItems;
    });
    scheduleArchivedSnapshotRefresh(ctx);
    await refreshProjectsSnapshot(ctx, { force: true });
    writeJson(ctx.res, 200, { ok: true });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'archive_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleGetArchivedSessionsRequest(ctx) {
  const {
    url,
    writeJson
  } = ctx;

  try {
    const forceRefresh = url.searchParams?.get('refresh') === '1' || (url.search && url.search.includes('refresh=1'));
    const snapshot = await getArchivedSnapshot(ctx, {
      forceRefresh,
      waitForRefresh: forceRefresh
    });
    const archived = Array.isArray(snapshot.archived) ? snapshot.archived : [];
    writeJson(ctx.res, 200, { ok: true, archived });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'get_archived_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleUnarchiveSessionRequest(ctx) {
  const {
    readRequestBody,
    fs,
    writeJson
  } = ctx;

  const payload = await readRequestBody(ctx.req, { maxBytes: 1024 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);

  if (!payload || !payload.provider || !payload.sessionId) {
    writeJson(ctx.res, 400, { ok: false, error: 'missing_params' });
    return true;
  }

  try {
    const { provider, sessionId, projectDirName } = payload;
    const { getRealHome } = require('../sessions/session-reader');
    const hostHome = getRealHome();

    if (provider === 'codex') {
      const archivedDir = path.join(hostHome, '.codex', 'archived_sessions');
      const sessionsDir = path.join(hostHome, '.codex', 'sessions');
      if (fs.existsSync(archivedDir)) {
        for (const entry of fs.readdirSync(archivedDir)) {
          if (entry.includes(sessionId) && entry.endsWith('.jsonl')) {
            fs.renameSync(path.join(archivedDir, entry), path.join(sessionsDir, entry));
            break;
          }
        }
      }
    } else if (provider === 'claude') {
      if (projectDirName) {
        const projectDir = path.join(hostHome, '.claude', 'projects', projectDirName);
        const archivedFile = path.join(projectDir, '.archived', `${sessionId}.jsonl`);
        if (fs.existsSync(archivedFile)) {
          fs.renameSync(archivedFile, path.join(projectDir, `${sessionId}.jsonl`));
        }
      }
    } else if (provider === 'gemini') {
      if (projectDirName) {
        const chatsDir = path.join(hostHome, '.gemini', 'tmp', projectDirName, 'chats');
        const archivedDir = path.join(chatsDir, '.archived');
        if (fs.existsSync(archivedDir)) {
          for (const fileName of fs.readdirSync(archivedDir).filter((item) => item.endsWith('.json'))) {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(archivedDir, fileName), 'utf8'));
              if (data.sessionId === sessionId || fileName.replace('.json', '') === sessionId) {
                fs.renameSync(path.join(archivedDir, fileName), path.join(chatsDir, fileName));
                break;
              }
            } catch (_error) {}
          }
        }
      }
    }

    updateArchivedSnapshot(ctx, (items) => {
      return (Array.isArray(items) ? items : []).filter((item) => !(
        item.provider === provider
        && item.id === sessionId
        && String(item.projectDirName || '') === String(projectDirName || '')
      ));
    });
    scheduleArchivedSnapshotRefresh(ctx);
    await refreshProjectsSnapshot(ctx, { force: true });
    writeJson(ctx.res, 200, { ok: true });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'unarchive_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

module.exports = {
  handleGetAccountSessionsRequest,
  handleGetSessionMessagesRequest,
  handleGetSessionEventsRequest,
  handleArchiveSessionRequest,
  handleGetArchivedSessionsRequest,
  handleUnarchiveSessionRequest
};
