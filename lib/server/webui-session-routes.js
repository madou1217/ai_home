'use strict';

const path = require('node:path');

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
    writeJson,
    invalidateProjectsCache
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

    invalidateProjectsCache();
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
    fs,
    writeJson
  } = ctx;

  try {
    const { getRealHome } = require('../sessions/session-reader');
    const hostHome = getRealHome();
    const archived = [];

    try {
      const archivedDir = path.join(hostHome, '.codex', 'archived_sessions');
      if (fs.existsSync(archivedDir)) {
        for (const entry of fs.readdirSync(archivedDir, { withFileTypes: true })) {
          if (!entry.name.endsWith('.jsonl')) continue;
          const filePath = path.join(archivedDir, entry.name);
          const uuidMatch = entry.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
          if (!uuidMatch) continue;

          const stats = fs.statSync(filePath);
          let title = '未命名会话';
          try {
            const indexPath = path.join(hostHome, '.codex', 'session_index.jsonl');
            if (fs.existsSync(indexPath)) {
              const lines = fs.readFileSync(indexPath, 'utf8').split('\n').filter((line) => line.trim());
              for (const line of lines) {
                try {
                  const item = JSON.parse(line);
                  if (item.id === uuidMatch[1] && item.thread_name) title = item.thread_name;
                } catch (_error) {}
              }
            }
          } catch (_error) {}

          archived.push({ id: uuidMatch[1], title, provider: 'codex', archivedAt: stats.mtimeMs });
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
                    if (record.type === 'user' && record.message && record.message.content) {
                      let text = '';
                      if (typeof record.message.content === 'string') text = record.message.content;
                      else if (Array.isArray(record.message.content)) {
                        text = record.message.content.filter((block) => block.type === 'text').map((block) => block.text).join(' ');
                      }
                      if (
                        text &&
                        !text.startsWith('Caveat:') &&
                        !text.startsWith('<command-name>') &&
                        !text.startsWith('<local-command') &&
                        !text.startsWith('<ide_opened_file>')
                      ) {
                        title = text.slice(0, 50);
                        break;
                      }
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
        for (const projectName of fs.readdirSync(tmpDir)) {
          const archivedDir = path.join(tmpDir, projectName, 'chats', '.archived');
          if (!fs.existsSync(archivedDir)) continue;
          for (const fileName of fs.readdirSync(archivedDir).filter((item) => item.endsWith('.json'))) {
            try {
              const chatPath = path.join(archivedDir, fileName);
              const data = JSON.parse(fs.readFileSync(chatPath, 'utf8'));
              const sessionId = data.sessionId || fileName.replace('.json', '');
              let title = data.summary || '';
              if (!title && data.messages && data.messages.length > 0) {
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
                projectDirName: projectName,
                archivedAt: fs.statSync(chatPath).mtimeMs
              });
            } catch (_error) {}
          }
        }
      }
    } catch (_error) {}

    archived.sort((left, right) => right.archivedAt - left.archivedAt);
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
    writeJson,
    invalidateProjectsCache
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

    invalidateProjectsCache();
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
