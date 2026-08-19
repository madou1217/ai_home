'use strict';
const path = require('node:path');
const fs = require('fs-extra');
const { listCodexStateDbPaths: discoverCodexStateDbPaths } = require('./codex-state-db-discovery');
const os = require('node:os');
const { StringDecoder } = require('node:string_decoder');
const {
  readAgySessionMessagesFromFile,
  readGeminiSessionMessagesFromFile
} = require('./provider-session-adapters');
const {
  decorateMessagesWithTurnModels,
  normalizeModelReference
} = require('./session-message-metadata');
const {
  getOpenCodeDbPath,
  openOpenCodeDbAtPath
} = require('./opencode-session-store');
const {
  buildHostPathLookupVariants,
  normalizeHostPathForLookup
} = require('../runtime/windows-path-encoding');
const { canonicalizeProviderResourceValue } = require('../runtime/provider-resource-path');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');
const { listProvidersByCapability } = require('../provider-catalog');
const { readGrokProjects, readGrokSessionMessages, resolveGrokSessionDir } = require('./grok-session-store');
const { readKiroProjects, readKiroSessionMessages, readKiroSessionModel } = require('./kiro-session-store');
const {
  readZcodeProjects,
  readZcodeSessionMessages,
  readZcodeSessionModel
} = require('./zcode-session-store');
const {
  isCodexInteractiveSessionSource,
  isCodexSubagentThread,
  isCodexTopLevelInteractiveThread,
  isCodexWorktreeProjectPath,
  parseCodexThreadSource
} = require('./codex-visible-session-policy');

const { codexSessionIndexCache, claudeHistoryMetadataCache, codexSessionMetaCache, codexSessionPathCache, sessionMessageCache, sessionMessageSnapshotCursors, sessionMessageSnapshotErrors, CODEX_SESSION_META_MAX_BYTES, CLAUDE_SESSION_META_MAX_BYTES, SESSION_MESSAGE_CACHE_MAX_ENTRIES, SESSION_MESSAGE_CACHE_MAX_ESTIMATED_BYTES, SESSION_MESSAGE_CACHE_MAX_ENTRY_ESTIMATED_BYTES, CODEX_SESSION_EVENTS_MAX_BYTES, CACHEABLE_SESSION_MESSAGE_PROVIDERS, ACCOUNT_SESSION_STORE_PROVIDERS, DEFAULT_HOST_PROJECT_PROVIDERS, DatabaseSyncCtor, didResolveDatabaseSync, getDatabaseSyncCtor, getRealHome, safeParseJsonLine, trimToolResultOutput, mergeUniqueStrings, toTimestampMs, areCloseTimestamps, CODEX_MOBILE_ATTACHMENT_MARKER, CODEX_MOBILE_PREAMBLE_PATTERN, createSessionJsonlSnapshotShortReadError, forEachJsonlLineRangeSync, forEachJsonlLineSync, forEachJsonlLineSyncFromOffset, resolveQoderProjectsRoots, resolveGrokSessionsRoots, resolveKiroDatabasePath, readQoderProjects, normalizeProjectPathForLookup, getSqliteTableColumns, readProjectNameMappings, applyProjectNameMappings, sanitizeProjectSessions, normalizeProviderFilter, normalizeProjectHintSet, readAgyProjectsFromHost, readQoderSessionMessages, readAgySessionMessages, OPENCODE_TOOL_OUTPUT_MAX_CHARS, resolveAgySessionPath, SESSION_FILE_CAPABLE_PROVIDERS, resolveZcodeDatabasePath, resolveQoderSessionPath } = require('./session-reader-utils');
const { isMissingPathError, createCodexPathResolutionContext, rememberCodexPathResolutionError, throwRememberedCodexPathResolutionError, cleanCodexExecCommandOutput, basenameLike, summarizeCommandLabel, shouldSkipCodexFunctionCall, buildCodexExecCommandResult, extractCodexFunctionOutput, normalizeCodexFunctionCall, isCodexGoalToolName, summarizeCodexToolCallLabel, isSyntheticCodexUserContent, isCodexGoalContextContent, isCodexSessionTitleSyntheticContent, compactCodexSessionTitle, stripEmbeddedCodexSessionPickerTranscript, normalizeCodexSessionTitle, extractCodexUserResponseMessage, extractCodexMobileAttachmentPreamble, cleanCodexUserMessageContent, toCodexUserMessageKey, getCodexImagePriority, preferCodexImageSource, mergeCodexUserImages, guessImageMimeTypeFromPath, toRenderableCodexImageSource, extractCodexReasoningText, collectCodexWorkspaceRoots, resetCodexSessionIndexCache, readCodexSessionIndexMap, extractCodexSessionIdFromPath, normalizeCodexSessionFilePath, cacheCodexSessionPath, getCachedCodexSessionPath, getCachedCodexSessionMeta, pruneCodexSessionMetaCache, removeCodexSessionMetaCacheEntry, parseJsonStringLiteral, readCodexSessionMeta, readCodexSessionCwd, extractCodexUserTitleFromPayload, readCodexSessionTitle, buildCodexProjectFromSessions, buildCodexSessionRecord, listCodexStateDbPaths, readCodexSpawnedChildIds, getCodexSubagentSourceMetadata, getCodexSubagentTaskName, readCodexChildThreadDescriptors, createCodexSubagentResolver, buildCodexThreadsQuery, resolveCodexSessionPathFromStateDb, createEmptyCodexThreadSnapshot, getCodexThreadUpdatedAtMs, countCodexThreadFields, shouldReplaceCodexThreadRow, readCodexThreadSnapshotFromStateDb, addCodexSessionRecord, collectCachedCodexSessionFilesByProjectPaths, readCodexSessionProjectPath, readCodexProjectsFromHostByPaths, readCodexProjectsFromHost, readCodexSessionMessagesSnapshot, readCodexSessionMessages, resolveCodexSessionPath } = require('./session-reader-codex');
const { extractClaudeImageMarkerPaths, stripClaudeImageMarkers, normalizeClaudeImageSource, normalizeClaudeToolResultContent, isRenderableClaudeImageReference, selectClaudeImages, preferIncomingClaudeImages, tryMergeClaudeUserMessage, tryMergeClaudeAssistantMessage, getClaudeAssistantBoundaryKey, shiftClaudeImageReferences, sanitizePath, resolveClaudeProjectPath, normalizeClaudeHistoryTitle, readClaudeHistorySessionMetadata, readClaudeProjectFromHostDir, readClaudeProjectsFromHostByDirNames, readClaudeProjectsFromHost, readClaudeSessionMessages, resolveClaudeSessionPath } = require('./session-reader-claude');
const { buildGeminiProjectPathMap, readGeminiJsonChatSession, readGeminiJsonlChatSession, readGeminiProjectFromHostName, readGeminiProjectsFromHostByNames, readGeminiProjectsFromHost, readGeminiSessionMessages, resolveGeminiSessionPath } = require('./session-reader-gemini');
const { parseJsonSafe, isPathWithinRoot, resolveOpenCodeAuthorizedDbCandidate, collectOpenCodeDbPaths, readOpenCodeSessionLocationFromDb, resolveOpenCodeSessionDbPath, readOpenCodeSessionRowsFromDb, readOpenCodeProjectsFromHostByPaths, readOpenCodeProjectsFromHost, normalizeOpenCodeMessageText, readOpenCodeChildFinalText, stripTaskWrapperTags, capOpenCodeToolText, renderOpenCodeToolPart, readOpenCodeMessagesFromDb, readOpenCodeSessionMessages, resolveOpenCodeSessionPath } = require('./session-reader-opencode');
function collectKnownProjectPaths() {
  const hostHome = getRealHome();
  const paths = new Set();

  function addKnownPath(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    paths.add(normalized);
  }

  collectCodexWorkspaceRoots().forEach(addKnownPath);

  // 从 Gemini trustedFolders.json
  try {
    const trustedPath = path.join(hostHome, '.gemini', 'trustedFolders.json');
    if (fs.existsSync(trustedPath)) {
      const data = JSON.parse(fs.readFileSync(trustedPath, 'utf8'));
      for (const p of Object.keys(data)) {
        addKnownPath(p);
      }
    }
  } catch (e) { /* ignore */ }

  // 从 Gemini history 目录的 .project_root
  try {
    const historyDir = path.join(hostHome, '.gemini', 'history');
    if (fs.existsSync(historyDir)) {
      for (const name of fs.readdirSync(historyDir)) {
        const rootFile = path.join(historyDir, name, '.project_root');
        if (fs.existsSync(rootFile)) {
          const p = fs.readFileSync(rootFile, 'utf8').trim();
          addKnownPath(p);
        }
      }
    }
  } catch (e) { /* ignore */ }

  return paths;
}

function readAccountScopedProjects(provider, options = {}) {
  switch (provider) {
    case 'qoder':
    case 'qodercn':
      return readQoderProjects(provider, options);
    case 'grok':
      return readGrokProjects({
        roots: resolveGrokSessionsRoots(options),
        accountRef: options.accountRef
      });
    case 'kiro':
      return readKiroProjects(resolveKiroDatabasePath(options), { accountRef: options.accountRef });
    default:
      return [];
  }
}

function readProjectsFromHostByProviders(providers, options = {}) {
  const requestedProviders = normalizeProviderFilter(providers);
  const knownPaths = collectKnownProjectPaths();
  const nameMappings = readProjectNameMappings();
  const projectHints = options && typeof options === 'object'
    ? options.projectHints || {}
    : {};
  const claudeProjectDirs = normalizeProjectHintSet(projectHints.claudeProjectDirs);
  const codexProjectPaths = normalizeProjectHintSet(projectHints.codexProjectPaths);
  const geminiProjectNames = normalizeProjectHintSet(projectHints.geminiProjectNames);
  const opencodeProjectPaths = normalizeProjectHintSet(projectHints.opencodeProjectPaths);
  const projects = [];

  if (requestedProviders.has('claude')) {
    projects.push(...(
      claudeProjectDirs.size > 0
        ? readClaudeProjectsFromHostByDirNames(Array.from(claudeProjectDirs), knownPaths)
        : readClaudeProjectsFromHost(knownPaths)
    ));
  }
  if (requestedProviders.has('codex')) {
    projects.push(...(
      codexProjectPaths.size > 0
        ? readCodexProjectsFromHostByPaths(Array.from(codexProjectPaths))
        : readCodexProjectsFromHost()
    ));
  }
  if (requestedProviders.has('gemini')) {
    projects.push(...(
      geminiProjectNames.size > 0
        ? readGeminiProjectsFromHostByNames(Array.from(geminiProjectNames))
        : readGeminiProjectsFromHost()
    ));
  }
  if (requestedProviders.has('agy')) {
    projects.push(...readAgyProjectsFromHost());
  }
  if (requestedProviders.has('opencode')) {
    projects.push(...(
      opencodeProjectPaths.size > 0
        ? readOpenCodeProjectsFromHostByPaths(Array.from(opencodeProjectPaths))
        : readOpenCodeProjectsFromHost()
    ));
  }
  for (const provider of ACCOUNT_SESSION_STORE_PROVIDERS) {
    if (requestedProviders.has(provider)) projects.push(...readAccountScopedProjects(provider, options));
  }
  if (requestedProviders.has('zcode')) {
    projects.push(...readZcodeProjects(resolveZcodeDatabasePath(options), { accountRef: options.accountRef }));
  }

  return sanitizeProjectSessions(applyProjectNameMappings(projects, nameMappings));
}

// ============================================================
// 读取所有项目（主入口）
// ============================================================
function readAllProjectsFromHost() {
  return readProjectsFromHostByProviders(DEFAULT_HOST_PROJECT_PROVIDERS);
}

function readOpenCodeSessionModel(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const dbPath = resolveOpenCodeSessionDbPath(id);
  if (!dbPath) return '';
  let db = null;
  try {
    db = openOpenCodeDbAtPath(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only = ON;');
    const columns = getSqliteTableColumns(db, 'session');
    if (!columns.has('id') || !columns.has('model')) return '';
    const row = db.prepare('SELECT model FROM session WHERE id = ?').get(id);
    const raw = row && row.model;
    if (!raw) return '';
    const parsed = parseJsonSafe(raw);
    if (parsed && parsed.id) {
      const providerId = String(parsed.providerID || parsed.providerId || '').trim();
      const modelId = String(parsed.id || '').trim();
      return providerId ? `${providerId}/${modelId}` : modelId;
    }
    const asText = String(raw).trim();
    return asText && asText[0] !== '{' ? asText : '';
  } catch (_error) {
    return '';
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_closeError) {}
    }
  }
}

function getSessionFileCursor(provider, params = {}) {
  const filePath = resolveSessionFilePath(provider, params);
  if (!filePath || !fs.existsSync(filePath)) return 0;
  try {
    return Number(fs.statSync(filePath).size) || 0;
  } catch (_error) {
    return 0;
  }
}

function readCodexSessionEvents(sessionId, options = {}) {
  const hostHome = getRealHome();
  const sessionPath = resolveCodexSessionPath(sessionId, hostHome);
  const cursor = Math.max(0, Number(options.cursor) || 0);
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    return {
      events: [],
      cursor: 0,
      requiresSnapshot: cursor > 0,
      hasAssistantToolCall: false
    };
  }

  let nextCursor = getSessionFileCursor('codex', { sessionId });
  if (cursor > nextCursor) {
    return {
      events: [],
      cursor: nextCursor,
      requiresSnapshot: true,
      hasAssistantToolCall: false
    };
  }
  if (cursor === nextCursor) {
    return { events: [], cursor: nextCursor, hasAssistantToolCall: false };
  }

  const events = [];
  const seenUserKeys = new Set();
  const seenReasoningKeys = new Set();
  let requiresSnapshot = false;
  let handledNoopEvent = false;
  let hasAssistantToolCall = false;
  let activeModel = '';
  let eventBytes = 2; // JSON array brackets.
  let eventsOverflow = false;
  const serializedEventBytes = (event) => {
    try {
      return Buffer.byteLength(JSON.stringify(event), 'utf8');
    } catch (_error) {
      return Number.POSITIVE_INFINITY;
    }
  };
  const markEventsOverflow = () => {
    eventsOverflow = true;
    requiresSnapshot = true;
    events.length = 0;
    eventBytes = 2;
  };
  const appendEvent = (event) => {
    if (eventsOverflow) return false;
    const decoratedEvent = activeModel && String(event && event.type || '').startsWith('assistant_')
      ? { ...event, model: event.model || activeModel }
      : event;
    const bytes = serializedEventBytes(decoratedEvent);
    const separatorBytes = events.length > 0 ? 1 : 0;
    if (eventBytes + separatorBytes + bytes > CODEX_SESSION_EVENTS_MAX_BYTES) {
      markEventsOverflow();
      return false;
    }
    events.push(decoratedEvent);
    eventBytes += separatorBytes + bytes;
    return true;
  };
  const replaceEvent = (index, event) => {
    if (eventsOverflow || index < 0 || index >= events.length) return false;
    const nextBytes = eventBytes
      - serializedEventBytes(events[index])
      + serializedEventBytes(event);
    if (nextBytes > CODEX_SESSION_EVENTS_MAX_BYTES) {
      markEventsOverflow();
      return false;
    }
    events[index] = event;
    eventBytes = nextBytes;
    return true;
  };
  const upsertUserEvent = (eventLike) => {
    const rawImages = mergeUniqueStrings([], eventLike && eventLike.images);
    const { content: preambleStripped, source } = extractCodexMobileAttachmentPreamble(eventLike && eventLike.content);
    const content = cleanCodexUserMessageContent(preambleStripped, rawImages.length > 0);
    const timestamp = String(eventLike && eventLike.timestamp || '').trim();
    const messageKey = toCodexUserMessageKey(content);
    if (isSyntheticCodexUserContent(content)) {
      handledNoopEvent = true;
      return;
    }
    if (!content && rawImages.length === 0) return;

    const existingIndex = events.findLastIndex((existing) => {
      if (!existing || existing.type !== 'user_message') return false;
      if (!areCloseTimestamps(existing.timestamp, timestamp)) return false;
      return toCodexUserMessageKey(existing.content) === messageKey;
    });

    if (existingIndex >= 0) {
      const existing = events[existingIndex];
      replaceEvent(existingIndex, {
        ...existing,
        content: content.length > String(existing.content || '').length ? content : existing.content,
        images: mergeCodexUserImages(existing.images, rawImages),
        ...((existing.source) || source ? { source: existing.source || source } : {})
      });
      return;
    }

    const dedupeKey = `${timestamp}::${messageKey}`;
    if (seenUserKeys.has(dedupeKey)) return;
    seenUserKeys.add(dedupeKey);
    appendEvent({
      type: 'user_message',
      timestamp,
      content,
      images: mergeCodexUserImages([], rawImages),
      ...(source ? { source } : {})
    });
  };

  nextCursor = forEachJsonlLineSyncFromOffset(sessionPath, cursor, (line) => {
    const record = safeParseJsonLine(line);
    if (!record) return;
    const payload = record.payload || {};

    if (record.type === 'turn_context') {
      activeModel = String(payload.model || '').trim();
      if (activeModel) {
        const userEventIndex = events.findLastIndex((event) => event && event.type === 'user_message');
        if (userEventIndex >= 0 && !events[userEventIndex].model) {
          replaceEvent(userEventIndex, { ...events[userEventIndex], model: activeModel });
        }
      }
      return;
    }

    if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      const message = extractCodexUserResponseMessage(payload);
      if (!message.content && (!Array.isArray(message.images) || message.images.length === 0)) return;
      upsertUserEvent({
        timestamp: record.timestamp,
        content: message.content,
        images: message.images || []
      });
      return;
    }

    if (record.type === 'event_msg' && payload.type === 'user_message') {
      const images = mergeUniqueStrings(payload.images, payload.local_images).map(toRenderableCodexImageSource);
      upsertUserEvent({
        timestamp: record.timestamp,
        content: payload.message,
        images
      });
      return;
    }

    if (record.type === 'event_msg' && payload.type === 'turn_aborted') {
      handledNoopEvent = true;
      return;
    }

    if (record.type === 'event_msg' && payload.type === 'agent_reasoning') {
      const text = extractCodexReasoningText(payload);
      const key = `${record.timestamp || ''}::${text}`;
      if (!text || seenReasoningKeys.has(key)) return;
      seenReasoningKeys.add(key);
      appendEvent({
        type: 'assistant_reasoning',
        timestamp: record.timestamp,
        text
      });
      return;
    }

    if (record.type === 'response_item' && payload.type === 'reasoning') {
      const text = extractCodexReasoningText(payload);
      const key = `${record.timestamp || ''}::${text}`;
      if (!text || seenReasoningKeys.has(key)) return;
      seenReasoningKeys.add(key);
      appendEvent({
        type: 'assistant_reasoning',
        timestamp: record.timestamp,
        text
      });
      return;
    }

    if (record.type === 'response_item' && payload.role === 'assistant') {
      const contentBlocks = Array.isArray(payload.content) ? payload.content : [];
      const text = contentBlocks
        .filter((item) => item && item.type === 'output_text' && item.text)
        .map((item) => String(item.text || ''))
        .join('\n')
        .trim();
      if (!text) return;
      appendEvent({
        type: 'assistant_text',
        timestamp: record.timestamp,
        text
      });
      return;
    }

    if (record.type === 'response_item' && payload.type === 'function_call') {
      const normalized = normalizeCodexFunctionCall(payload, new Map());
      if (!normalized) return;
      hasAssistantToolCall = true;
      appendEvent({
        type: 'assistant_tool_call',
        timestamp: record.timestamp,
        callId: payload.call_id,
        content: normalized.content
      });
      return;
    }

    if (record.type === 'event_msg' && payload.type === 'exec_command_end' && payload.call_id) {
      const resultInfo = buildCodexExecCommandResult(payload);
      const normalized = normalizeCodexFunctionCall({
        type: 'function_call',
        name: 'exec_command',
        call_id: payload.call_id,
        arguments: JSON.stringify({
          cmd: Array.isArray(payload.command) ? payload.command[payload.command.length - 1] || '' : '',
          workdir: payload.cwd || ''
        })
      }, new Map([[payload.call_id, resultInfo]]));
      if (!normalized) return;
      appendEvent({
        type: 'assistant_tool_result',
        timestamp: record.timestamp,
        callId: payload.call_id,
        content: normalized.content
      });
      return;
    }

    if (record.type === 'response_item' && payload.type === 'function_call_output' && payload.call_id) {
      // 单独的 function_call_output 缺少足够的结构化上下文，直接增量拼接很容易破坏格式。
      // 遇到这种情况时让前端回退到 snapshot 重读，保证最终展示正确。
      requiresSnapshot = true;
    }
  }, {
    acceptFinalLine: (line) => Boolean(safeParseJsonLine(line))
  });

  if (events.length === 0 && nextCursor > cursor && !handledNoopEvent) {
    requiresSnapshot = true;
  }

  return { events, cursor: nextCursor, requiresSnapshot, hasAssistantToolCall };
}

function readSessionEvents(provider, params = {}, options = {}) {
  switch (provider) {
    case 'codex':
      return readCodexSessionEvents(params.sessionId, options);
    default: {
      const requestedCursor = Math.max(0, Number(options.cursor) || 0);
      const nextCursor = getSessionFileCursor(provider, params);
      return {
        events: [],
        cursor: nextCursor,
        requiresSnapshot: nextCursor !== requestedCursor,
        hasAssistantToolCall: false
      };
    }
  }
}

// provider -> resolveSessionFilePath() 有真实实现的集合(与下面 switch 的 case 列表保持同步)。
// 供 provider-session-hook-config.js 判断 “无官方 hook 时是否还有轮询兜底” 使用。
function resolveSessionFilePath(provider, params = {}, options = {}) {
  const { sessionId, projectDirName } = params;
  switch (provider) {
    case 'claude':
      return resolveClaudeSessionPath(sessionId, projectDirName);
    case 'codex':
      return resolveCodexSessionPath(sessionId, getRealHome(), options);
    case 'gemini':
      return resolveGeminiSessionPath(sessionId, projectDirName);
    case 'qoder':
    case 'qodercn':
      return resolveQoderSessionPath(provider, sessionId, projectDirName, options);
    case 'grok': {
      const sessionDir = resolveGrokSessionDir(sessionId, projectDirName, { roots: resolveGrokSessionsRoots(options) });
      return sessionDir ? path.join(sessionDir, 'chat_history.jsonl') : '';
    }
    case 'kiro':
      return resolveKiroDatabasePath(options);
    case 'zcode':
      return resolveZcodeDatabasePath(options);
    case 'agy':
      return resolveAgySessionPath(sessionId);
    case 'opencode':
      return resolveOpenCodeSessionPath(sessionId);
    default:
      return '';
  }
}

function readSessionLastModel(provider, params = {}, options = {}) {
  try {
    if (provider === 'opencode') return String(readOpenCodeSessionModel(params.sessionId) || '');
    if (provider === 'kiro') return readKiroSessionModel(resolveKiroDatabasePath(options), params.sessionId);
    if (provider === 'zcode') return readZcodeSessionModel(resolveZcodeDatabasePath(options), params.sessionId);
    const filePath = resolveSessionFilePath(provider, params, options);
    if (!filePath || !fs.existsSync(filePath)) return '';
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return '';
    const readBytes = Math.min(stat.size, 96 * 1024);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readBytes);
    try {
      fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
    } finally {
      fs.closeSync(fd);
    }
    const matches = buf.toString('utf8').match(/"model"\s*:\s*"([^"]{1,80})"/g);
    if (!matches || matches.length === 0) return '';
    const last = matches[matches.length - 1].match(/"model"\s*:\s*"([^"]{1,80})"/);
    return last ? last[1] : '';
  } catch (_error) {
    return '';
  }
}

function resolveSessionResourceContext(options = {}) {
  const hostHomeDir = String(options.hostHomeDir || getRealHome()).trim();
  const aiHomeDir = String(options.aiHomeDir || (hostHomeDir ? path.join(hostHomeDir, '.ai_home') : '')).trim();
  return { aiHomeDir, hostHomeDir };
}

function canonicalizeSessionMessages(provider, messages, options = {}) {
  const { aiHomeDir, hostHomeDir } = resolveSessionResourceContext(options);
  return canonicalizeProviderResourceValue(decorateMessagesWithTurnModels(messages), {
    provider,
    aiHomeDir,
    hostHomeDir
  });
}

function readSessionMessagesUncached(provider, params = {}, options = {}) {
  const { sessionId, projectDirName } = params;
  let messages;
  switch (provider) {
    case 'claude':
      messages = readClaudeSessionMessages(sessionId, projectDirName, options);
      break;
    case 'codex':
      messages = readCodexSessionMessages(sessionId, options);
      break;
    case 'gemini':
      messages = readGeminiSessionMessages(sessionId, projectDirName, options);
      break;
    case 'qoder':
    case 'qodercn':
      messages = readQoderSessionMessages(provider, sessionId, projectDirName, options);
      break;
    case 'grok':
      messages = readGrokSessionMessages(resolveGrokSessionDir(sessionId, projectDirName, { roots: resolveGrokSessionsRoots(options) }));
      break;
    case 'kiro':
      messages = readKiroSessionMessages(resolveKiroDatabasePath(options), sessionId);
      break;
    case 'zcode':
      messages = readZcodeSessionMessages(resolveZcodeDatabasePath(options), sessionId);
      break;
    case 'agy':
      messages = readAgySessionMessages(sessionId, options);
      break;
    case 'opencode':
      messages = readOpenCodeSessionMessages(sessionId, options);
      break;
    default:
      messages = [];
      break;
  }
  return canonicalizeSessionMessages(provider, messages, options);
}

function estimateSessionMessagesMemoryBytes(messages) {
  const pending = [messages];
  const visited = new WeakSet();
  let bytes = 0;

  while (pending.length > 0 && bytes <= SESSION_MESSAGE_CACHE_MAX_ENTRY_ESTIMATED_BYTES) {
    const value = pending.pop();
    if (typeof value === 'string') {
      bytes += 16 + value.length * 2;
      continue;
    }
    if (typeof value === 'number') {
      bytes += 8;
      continue;
    }
    if (typeof value === 'boolean') {
      bytes += 4;
      continue;
    }
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);

    if (Array.isArray(value)) {
      bytes += 32 + value.length * 8;
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push(value[index]);
      }
      continue;
    }

    const keys = Object.keys(value);
    bytes += 64 + keys.length * 8;
    for (const key of keys) {
      bytes += 16 + key.length * 2;
      pending.push(value[key]);
    }
  }

  return bytes;
}

function getFileStatFingerprint(filePath, knownStats = null) {
  try {
    const stats = knownStats || fs.statSync(filePath);
    return `${filePath}:${Number(stats.size) || 0}:${Number(stats.mtimeMs) || 0}`;
  } catch (_error) {
    return `${filePath}:missing`;
  }
}

function getCodexStateCacheVersion() {
  const fingerprints = [];
  const codexDir = path.join(getRealHome(), '.codex');
  for (const stateDbPath of listCodexStateDbPaths(codexDir)) {
    fingerprints.push(getFileStatFingerprint(stateDbPath));
    fingerprints.push(getFileStatFingerprint(`${stateDbPath}-wal`));
  }
  return fingerprints.join('|');
}

function getCodexDescriptorCacheVersion(sessionId) {
  const codexDir = path.join(getRealHome(), '.codex');
  return JSON.stringify(readCodexChildThreadDescriptors(codexDir, sessionId));
}

function dependsOnCodexState(messages) {
  return messages.some((message) => (
    String(message && message.content || '').includes(':::tool{name="spawn_agent"}')
  ));
}

function touchSessionMessageCache(cacheKey, cached) {
  sessionMessageCache.delete(cacheKey);
  sessionMessageCache.set(cacheKey, cached);
  sessionMessageSnapshotCursors.set(cached.messages, cached.snapshotCursor);
  return cached.messages;
}

function readCachedSessionMessages(cacheKey, cached, context) {
  if (!cached || cached.fileVersion !== context.fileVersion) return null;
  if (!cached.dependsOnCodexState) return touchSessionMessageCache(cacheKey, cached);

  const stateVersion = getCodexStateCacheVersion();
  if (cached.stateVersion === stateVersion) return touchSessionMessageCache(cacheKey, cached);

  const descriptorVersion = getCodexDescriptorCacheVersion(context.sessionId);
  if (cached.descriptorVersion !== descriptorVersion) return null;
  cached.stateVersion = stateVersion;
  return touchSessionMessageCache(cacheKey, cached);
}

function pruneSessionMessageCache() {
  let estimatedBytes = 0;
  for (const entry of sessionMessageCache.values()) {
    estimatedBytes += entry.estimatedBytes;
  }
  while (
    sessionMessageCache.size > SESSION_MESSAGE_CACHE_MAX_ENTRIES
    || estimatedBytes > SESSION_MESSAGE_CACHE_MAX_ESTIMATED_BYTES
  ) {
    const oldestKey = sessionMessageCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = sessionMessageCache.get(oldestKey);
    estimatedBytes -= oldest ? oldest.estimatedBytes : 0;
    sessionMessageCache.delete(oldestKey);
  }
}

function readSessionMessages(provider, params = {}, options = {}) {
  // OpenCode writes through SQLite WAL, so the main DB file's size/mtime is not
  // a valid freshness key. Codex stays cacheable because its transcript and
  // state SQLite/WAL dependencies are all included in the cache version.
  if (!CACHEABLE_SESSION_MESSAGE_PROVIDERS.has(provider)) {
    return readSessionMessagesUncached(provider, params, options);
  }
  const filePath = resolveSessionFilePath(provider, params, options);
  if (!filePath) {
    return readSessionMessagesUncached(provider, params, options);
  }

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    if (options.throwOnError && !isMissingPathError(error)) throw error;
    return readSessionMessagesUncached(provider, params, options);
  }
  if (!stats.isFile()) return readSessionMessagesUncached(provider, params, options);

  const resourceContext = resolveSessionResourceContext(options);
  const cacheKey = JSON.stringify([
    provider,
    filePath,
    resourceContext.aiHomeDir,
    resourceContext.hostHomeDir
  ]);
  const fileVersion = getFileStatFingerprint(filePath, stats);
  const cached = sessionMessageCache.get(cacheKey);
  const cachedMessages = readCachedSessionMessages(cacheKey, cached, {
    fileVersion,
    sessionId: params.sessionId
  });
  if (cachedMessages) return cachedMessages;
  if (cached) sessionMessageCache.delete(cacheKey);

  const stateVersionBeforeParse = provider === 'codex'
    ? getCodexStateCacheVersion()
    : '';
  const parsedSnapshot = provider === 'codex'
    ? readCodexSessionMessagesSnapshot(params.sessionId, options)
    : null;
  const rawMessages = parsedSnapshot
    ? (parsedSnapshot.complete ? parsedSnapshot.messages : [])
    : readSessionMessagesUncached(provider, params, options);
  const messages = parsedSnapshot
    ? canonicalizeSessionMessages(provider, rawMessages, options)
    : rawMessages;
  const snapshotCursor = parsedSnapshot
    ? parsedSnapshot.cursor
    : getSessionFileCursor(provider, params);
  sessionMessageSnapshotCursors.set(messages, snapshotCursor);
  if (parsedSnapshot && !parsedSnapshot.complete) {
    if (options.throwOnError) {
      throw parsedSnapshot.readError || new Error('session_transcript_read_incomplete');
    }
    sessionMessageSnapshotErrors.set(
      messages,
      parsedSnapshot.readError || new Error('session_transcript_read_incomplete')
    );
  }
  const estimatedBytes = estimateSessionMessagesMemoryBytes(messages);
  const readsCodexState = provider === 'codex' && dependsOnCodexState(messages);
  const stateVersionAfterParse = readsCodexState ? getCodexStateCacheVersion() : '';
  const descriptorVersion = readsCodexState
    ? getCodexDescriptorCacheVersion(params.sessionId)
    : '';
  const stateVersionAtCache = readsCodexState ? getCodexStateCacheVersion() : '';
  const dependenciesStayedStable = !readsCodexState
    || (
      stateVersionBeforeParse === stateVersionAfterParse
      && stateVersionAfterParse === stateVersionAtCache
    );
  if (
    dependenciesStayedStable
    && messages.length > 0
    && estimatedBytes <= SESSION_MESSAGE_CACHE_MAX_ENTRY_ESTIMATED_BYTES
  ) {
    sessionMessageCache.set(cacheKey, {
      fileVersion,
      stateVersion: stateVersionAtCache,
      descriptorVersion,
      dependsOnCodexState: readsCodexState,
      snapshotCursor,
      estimatedBytes,
      messages
    });
    pruneSessionMessageCache();
  }
  return messages;
}

function readSessionMessagesSnapshot(provider, params = {}, options = {}) {
  const cursorBeforeRead = provider === 'codex'
    ? null
    : getSessionFileCursor(provider, params);
  const messages = readSessionMessages(provider, params, { ...options, throwOnError: true });
  const readError = sessionMessageSnapshotErrors.get(messages);
  if (readError) throw readError;
  const cursor = provider === 'codex' && sessionMessageSnapshotCursors.has(messages)
    ? sessionMessageSnapshotCursors.get(messages)
    : cursorBeforeRead;
  return {
    messages,
    cursor: Math.max(0, Number(cursor) || 0)
  };
}

module.exports = {
  readAllProjectsFromHost,
  readProjectsFromHostByProviders,
  readCodexSessionProjectPath,
  readSessionMessages,
  readSessionMessagesSnapshot,
  readSessionLastModel,
  readOpenCodeSessionModel,
  readSessionEvents,
  resolveSessionFilePath,
  SESSION_FILE_CAPABLE_PROVIDERS,
  getSessionFileCursor,
  getRealHome,
  collectCodexWorkspaceRoots
};
