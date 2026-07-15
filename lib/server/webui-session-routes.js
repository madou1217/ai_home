'use strict';

const path = require('node:path');
const { refreshProjectsSnapshot } = require('./webui-project-cache');
const { notifyWebUiProjectWatchers } = require('./webui-project-watch');
const {
  getArchivedSnapshot,
  scheduleArchivedSnapshotRefresh,
  updateArchivedSnapshot
} = require('./webui-archived-cache');
const { buildSessionMessagePage } = require('./session-message-page');

function refreshProjectsSnapshotAndNotify(ctx) {
  refreshProjectsSnapshot(ctx, { force: true })
    .then(() => notifyWebUiProjectWatchers(ctx, { force: true }))
    .catch(() => {});
}

async function handleGetAccountSessionsRequest(ctx) {
  const {
    pathname,
    deps = {},
    writeJson
  } = ctx;

  const matches = pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)$/);
  const provider = matches[1];

  try {
    const sessionReader = require('../sessions/session-reader');
    const readProjects = typeof deps.readProjectsFromHostByProviders === 'function'
      ? deps.readProjectsFromHostByProviders
      : sessionReader.readProjectsFromHostByProviders;
    const projects = readProjects([provider]);
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
    writeJson,
    deps = {}
  } = ctx;

  const matches = pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)\/messages$/);
  const provider = matches[1];
  const sessionId = matches[2];

  try {
    const sessionReader = require('../sessions/session-reader');
    const readSessionMessagesSnapshot = typeof deps.readSessionMessagesSnapshot === 'function'
      ? deps.readSessionMessagesSnapshot
      : sessionReader.readSessionMessagesSnapshot;
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const projectDirName = requestUrl.searchParams.get('projectDirName');
    const params = { sessionId, projectDirName };
    let snapshot;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        snapshot = readSessionMessagesSnapshot(provider, params);
        break;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    const { messages, cursor } = snapshot;
    const page = buildSessionMessagePage(messages, requestUrl.searchParams);
    writeJson(ctx.res, 200, { ok: true, ...page, cursor });
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

// Flatten a message's `content` (string OR array of parts) to plain text.
function messageToPlainText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part && part.type === 'text' ? part.text : '')))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

// Last assistant reply (falling back to last user message) as a short snippet.
function extractSessionPreview(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (const role of ['assistant', 'user']) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (!m || m.role !== role) continue;
      const text = messageToPlainText(m.content).replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 140);
    }
  }
  return '';
}

// POST /v0/webui/sessions/previews — lazy, on-demand enrichment for the handful
// of sessions in a just-opened list group. Kept OFF the projects-snapshot hot
// path (which holds thousands of sessions): the client sends only the visible
// batch, and this reuses the existing per-session readers. Returns { id: {model, preview} }.
async function handleSessionPreviewsRequest(ctx) {
  const { readRequestBody, writeJson } = ctx;
  try {
    const payload = await readRequestBody(ctx.req, { maxBytes: 256 * 1024 })
      .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
      .catch(() => null);
    const items = Array.isArray(payload && payload.sessions) ? payload.sessions.slice(0, 40) : [];
    const { readSessionMessages, readSessionLastModel } = require('../sessions/session-reader');
    const modelUsageService = ctx.deps && ctx.deps.modelUsageService;
    const previews = {};
    for (const item of items) {
      const provider = String((item && item.provider) || '').trim();
      const id = String((item && item.id) || '').trim();
      if (!provider || !id) continue;
      const projectDirName = (item && item.projectDirName) || undefined;
      let model = '';
      try {
        // Prefer the model stamped on the session's last turn (matches "the last
        // message's model"); fall back to server-persisted usage records.
        model = String(readSessionLastModel(provider, { sessionId: id, projectDirName }) || '');
        if (!model && modelUsageService && typeof modelUsageService.getLastSessionModel === 'function') {
          model = String(modelUsageService.getLastSessionModel(provider, id) || '');
        }
      } catch (_modelError) { /* model stays empty → client falls back to provider */ }
      let preview = '';
      try {
        preview = extractSessionPreview(readSessionMessages(provider, { sessionId: id, projectDirName }));
      } catch (_previewError) { /* preview stays empty → client keeps 2-line title */ }
      previews[id] = { model, preview };
    }
    writeJson(ctx.res, 200, { ok: true, previews });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'get_previews_failed',
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
    refreshProjectsSnapshotAndNotify(ctx);
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
    refreshProjectsSnapshotAndNotify(ctx);
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
  handleSessionPreviewsRequest,
  handleGetSessionEventsRequest,
  handleArchiveSessionRequest,
  handleGetArchivedSessionsRequest,
  handleUnarchiveSessionRequest
};
