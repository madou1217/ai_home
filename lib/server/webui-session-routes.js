'use strict';

const { buildSessionMessagePage } = require('./session-message-page');
const { canonicalizeProviderResourceValue } = require('../runtime/provider-resource-path');
const { decorateMessagesWithRecordedTurnModels } = require('../sessions/session-message-metadata');

function applyCanonicalAgyTurnModels(messages, provider, sessionId, modelUsageService) {
  if (String(provider || '').trim().toLowerCase() !== 'agy') return messages;
  if (!modelUsageService || typeof modelUsageService.getNativeSessionModelTimeline !== 'function') {
    return messages;
  }
  try {
    return decorateMessagesWithRecordedTurnModels(
      messages,
      modelUsageService.getNativeSessionModelTimeline(provider, sessionId)
    );
  } catch (_error) {
    return messages;
  }
}

function canonicalizeSessionPayload(ctx, provider, payload) {
  const deps = ctx.deps || {};
  return canonicalizeProviderResourceValue(payload, {
    provider,
    aiHomeDir: deps.aiHomeDir || ctx.aiHomeDir,
    hostHomeDir: deps.hostHomeDir || ctx.hostHomeDir
  });
}

async function handleGetAccountSessionsRequest(ctx) {
  const {
    pathname,
    deps = {},
    writeJson
  } = ctx;

  const matches = pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)$/);
  const provider = matches[1];
  const accountRef = matches[2];

  try {
    const sessionReader = require('../sessions/session-reader');
    const readProjects = typeof deps.readProjectsFromHostByProviders === 'function'
      ? deps.readProjectsFromHostByProviders
      : sessionReader.readProjectsFromHostByProviders;
    const projects = readProjects([provider], {
      accountRef,
      aiHomeDir: deps.aiHomeDir || ctx.aiHomeDir,
      hostHomeDir: deps.hostHomeDir || ctx.hostHomeDir
    });
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
    const accountRef = requestUrl.searchParams.get('accountRef');
    const params = { sessionId, projectDirName };
  const chatStore = require('./webui-chat-store');
  const chatSession = chatStore.readChatSession(sessionId, ctx.hostHomeDir || (deps && deps.hostHomeDir));
  if (chatSession && Array.isArray(chatSession.messages)) {
    const page = buildSessionMessagePage(chatSession.messages, requestUrl.searchParams);
    writeJson(ctx.res, 200, canonicalizeSessionPayload(ctx, provider, {
      ok: true,
      ...page,
      cursor: null
    }));
    return true;
  }
    let snapshot;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        snapshot = readSessionMessagesSnapshot(provider, params, {
          aiHomeDir: deps.aiHomeDir || ctx.aiHomeDir,
          hostHomeDir: deps.hostHomeDir || ctx.hostHomeDir,
          accountRef
        });
        break;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    const { messages, cursor } = snapshot;
    const canonicalMessages = applyCanonicalAgyTurnModels(
      messages,
      provider,
      sessionId,
      deps.modelUsageService
    );
    const page = buildSessionMessagePage(canonicalMessages, requestUrl.searchParams);
    writeJson(ctx.res, 200, canonicalizeSessionPayload(ctx, provider, {
      ok: true,
      ...page,
      cursor
    }));
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
// batch, and this reuses the existing per-session readers. The response stays
// structured so UI identity remains a client-side concern.
async function handleSessionPreviewsRequest(ctx) {
  const { readRequestBody, writeJson, deps = {} } = ctx;
  try {
    const payload = await readRequestBody(ctx.req, { maxBytes: 256 * 1024 })
      .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
      .catch(() => null);
    const items = Array.isArray(payload && payload.sessions) ? payload.sessions.slice(0, 40) : [];
    const sessionReader = require('../sessions/session-reader');
    const readSessionMessages = typeof deps.readSessionMessages === 'function'
      ? deps.readSessionMessages
      : sessionReader.readSessionMessages;
    const readSessionLastModel = typeof deps.readSessionLastModel === 'function'
      ? deps.readSessionLastModel
      : sessionReader.readSessionLastModel;
    const modelUsageService = deps.modelUsageService;
    const previews = [];
    for (const item of items) {
      const provider = String((item && item.provider) || '').trim();
      const id = String((item && item.id) || '').trim();
      if (!provider || !id) continue;
      const projectDirName = (item && item.projectDirName) || undefined;
      const accountRef = (item && item.accountRef) || undefined;
      let model = '';
      try {
        const transcriptModel = String(readSessionLastModel(
          provider,
          { sessionId: id, projectDirName }
        ) || '');
        const recordedModel = modelUsageService && typeof modelUsageService.getLastSessionModel === 'function'
          ? String(modelUsageService.getLastSessionModel(provider, id) || '')
          : '';
        // AGY transcript 只保存 human label，且可能把新模型沿用成旧标签；native done
        // 记录保存的是本轮 canonical model ID，因此 AGY 必须优先使用持久化记录。
        model = String(provider).toLowerCase() === 'agy'
          ? recordedModel || transcriptModel
          : transcriptModel || recordedModel;
      } catch (_modelError) { /* model stays empty → client falls back to provider */ }
      let preview = '';
      try {
        preview = extractSessionPreview(readSessionMessages(
          provider,
          { sessionId: id, projectDirName },
          {
            accountRef,
            aiHomeDir: deps.aiHomeDir || ctx.aiHomeDir,
            hostHomeDir: deps.hostHomeDir || ctx.hostHomeDir
          }
        ));
      } catch (_previewError) { /* preview stays empty → client keeps 2-line title */ }
      previews.push({
        provider,
        id,
        ...(projectDirName ? { projectDirName } : {}),
        ...(accountRef ? { accountRef } : {}),
        model,
        preview
      });
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

// codex 的增量事件已由 Go 承接，并有 Node 真值对拍（test/webui-session-events-parity.test.js）。
// 其它 Provider 在 Node 侧依赖各自的会话定位器，仍由本地 reader 处理；Go 失败也一律回落，
// 代理只在「Go 明确成功且形状合法」时才接管。
async function tryHandleGetSessionEventsViaGo(ctx) {
  const { pathname, deps = {}, writeJson } = ctx;
  const match = pathname && pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)\/events$/);
  if (!match) return false;
  // 与 Node readSessionEvents 的 switch 同口径：大小写不匹配就不代理，避免改变既有行为。
  if (match[1] !== 'codex') return false;
  const goHost = deps.goCoreSync;
  if (!goHost || typeof goHost.getSessionEvents !== 'function') return false;
  if (typeof goHost.isEnabled === 'function' && !goHost.isEnabled()) return false;
  const queryString = ctx.url && ctx.url.searchParams ? ctx.url.searchParams.toString() : '';
  let result = null;
  try {
    result = await goHost.getSessionEvents(match[1], match[2], queryString);
  } catch (_error) {
    return false;
  }
  if (!result || result.ok !== true || !result.data || result.data.ok !== true) return false;
  // 形状不完整时同样回落：前端直接读 events/cursor，半截响应比慢一点更糟。
  if (!Array.isArray(result.data.events) || typeof result.data.cursor !== 'number') return false;
  writeJson(ctx.res, 200, result.data);
  return true;
}

async function handleGetSessionEventsRequest(ctx) {
  const {
    pathname,
    req,
    writeJson,
    deps = {}
  } = ctx;

  const matches = pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)\/events$/);
  const provider = matches[1];
  const sessionId = matches[2];

  try {
    const sessionReader = require('../sessions/session-reader');
    const readSessionEvents = typeof deps.readSessionEvents === 'function'
      ? deps.readSessionEvents
      : sessionReader.readSessionEvents;
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const projectDirName = requestUrl.searchParams.get('projectDirName');
    const cursor = Number(requestUrl.searchParams.get('cursor') || 0);
    const payload = readSessionEvents(provider, { sessionId, projectDirName }, { cursor });
    writeJson(ctx.res, 200, canonicalizeSessionPayload(ctx, provider, { ok: true, ...payload }));
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

module.exports = {
  handleGetAccountSessionsRequest,
  handleGetSessionMessagesRequest,
  handleSessionPreviewsRequest,
  handleGetSessionEventsRequest,
  tryHandleGetSessionEventsViaGo
};
