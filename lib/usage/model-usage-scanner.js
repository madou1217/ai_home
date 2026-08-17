'use strict';

const { isAccountRef } = require('../account/public-account-ref');
const { stableHash } = require('./model-usage-stable-hash');
const {
  readKimiSessionOwnershipIndex,
  resolvePhysicalPath
} = require('./kimi-session-index');

const CODEX_USAGE_STREAM_LIMIT = 16;
const CODEX_USAGE_EVENT_LIMIT = 32;
const CODEX_SCAN_CONTEXT_VERSION = 2;
const FIRST_JSONL_ENTRY_CHUNK_BYTES = 8 * 1024;
const FIRST_JSONL_ENTRY_MAX_BYTES = 256 * 1024;

function safeParseJson(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch (_error) {
    return null;
  }
}

function toTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseUuidV7Timestamp(value) {
  const match = String(value || '').trim().toLowerCase().match(
    /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  if (!match) return 0;
  const timestamp = Number.parseInt(`${match[1]}${match[2]}`, 16);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : 0;
}

function toInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function normalizeBoundedStrings(values, limit) {
  const normalized = Array.isArray(values)
    ? values.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  return Array.from(new Set(normalized)).slice(-limit);
}

function rememberBounded(values, value, limit) {
  const existingIndex = values.indexOf(value);
  if (existingIndex >= 0) values.splice(existingIndex, 1);
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

function normalizeCodexTokenUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const inputTokens = toInt(value.input_tokens);
  const outputTokens = toInt(value.output_tokens);
  return {
    inputTokens,
    cacheReadInputTokens: Math.min(inputTokens, toInt(value.cached_input_tokens)),
    outputTokens,
    reasoningOutputTokens: Math.min(outputTokens, toInt(value.reasoning_output_tokens)),
    totalTokens: inputTokens + outputTokens
  };
}

function codexUsageSignature(usage) {
  return [
    usage.inputTokens,
    usage.cacheReadInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens
  ].join(':');
}

function subtractCodexUsage(total, last) {
  const fields = [
    'inputTokens',
    'cacheReadInputTokens',
    'outputTokens',
    'reasoningOutputTokens'
  ];
  if (fields.some((field) => last[field] > total[field])) return null;
  return Object.fromEntries(fields.map((field) => [field, total[field] - last[field]]));
}

function createCodexUsageTracker(scanContext = {}) {
  return {
    baselines: normalizeBoundedStrings(
      scanContext.codexUsageBaselines,
      CODEX_USAGE_STREAM_LIMIT
    ),
    recentEvents: normalizeBoundedStrings(
      scanContext.codexUsageEventSignatures,
      CODEX_USAGE_EVENT_LIMIT
    )
  };
}

function resetCodexUsageTracker(tracker) {
  tracker.baselines.splice(0, tracker.baselines.length);
  tracker.recentEvents.splice(0, tracker.recentEvents.length);
}

function observeCodexUsage(tracker, totalValue, lastValue) {
  const total = normalizeCodexTokenUsage(totalValue);
  const last = normalizeCodexTokenUsage(lastValue);
  if (!total || !last) return null;

  const totalSignature = codexUsageSignature(total);
  const eventSignature = `${totalSignature}|${codexUsageSignature(last)}`;
  if (tracker.recentEvents.includes(eventSignature)) return null;
  rememberBounded(tracker.recentEvents, eventSignature, CODEX_USAGE_EVENT_LIMIT);

  if (tracker.baselines.includes(totalSignature)) {
    rememberBounded(tracker.baselines, totalSignature, CODEX_USAGE_STREAM_LIMIT);
    return null;
  }

  const previous = subtractCodexUsage(total, last);
  if (previous) {
    const previousIndex = tracker.baselines.indexOf(codexUsageSignature(previous));
    if (previousIndex >= 0) tracker.baselines.splice(previousIndex, 1);
  }
  rememberBounded(tracker.baselines, totalSignature, CODEX_USAGE_STREAM_LIMIT);

  return last.totalTokens > 0 ? last : null;
}

function normalizeProviderFilter(providers) {
  const values = Array.isArray(providers) ? providers : [];
  const set = new Set(
    values.map((provider) => String(provider || '').trim().toLowerCase()).filter(Boolean)
  );
  return set.size > 0 ? set : new Set(['codex', 'claude', 'gemini', 'agy', 'opencode', 'kimi']);
}

function pathExists(fs, targetPath) {
  try {
    return Boolean(targetPath && fs.existsSync(targetPath));
  } catch (_error) {
    return false;
  }
}

function listFilesRecursive(fs, path, root, acceptFile) {
  const normalizedRoot = String(root || '').trim();
  if (!pathExists(fs, normalizedRoot)) return [];
  const out = [];
  const stack = [normalizedRoot];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    entries.forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        return;
      }
      if (!entry.isFile()) return;
      if (typeof acceptFile === 'function' && !acceptFile(full, entry.name)) return;
      out.push(full);
    });
  }

  return out.sort((left, right) => left.localeCompare(right));
}

function readJsonlFromOffset(fs, filePath, offset, onLine) {
  const chunkSize = 256 * 1024;
  const buffer = Buffer.alloc(chunkSize);
  let fd = null;
  let cursor = Math.max(0, Number(offset) || 0);
  let lineStart = cursor;
  let pendingChunks = [];
  let pendingBytes = 0;
  let trailingLineStart = cursor;
  let hadTrailingLine = false;

  function appendBytes(start, end) {
    if (end <= start) return;
    const chunk = Buffer.from(buffer.subarray(start, end));
    pendingChunks.push(chunk);
    pendingBytes += chunk.length;
  }

  function emitLine() {
    const bytes = pendingChunks.length === 1
      ? pendingChunks[0]
      : Buffer.concat(pendingChunks, pendingBytes);
    const end = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d
      ? bytes.length - 1
      : bytes.length;
    const line = bytes.toString('utf8', 0, end);
    if (line.trim()) onLine(line, lineStart);
    pendingChunks = [];
    pendingBytes = 0;
  }

  try {
    fd = fs.openSync(filePath, 'r');
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, cursor);
      if (!bytesRead) break;
      let segmentStart = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        appendBytes(segmentStart, index);
        emitLine();
        lineStart = cursor + index + 1;
        segmentStart = index + 1;
      }
      appendBytes(segmentStart, bytesRead);
      cursor += bytesRead;
    }
    if (pendingBytes > 0) {
      trailingLineStart = lineStart;
      hadTrailingLine = true;
      emitLine();
    }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_error) {}
    }
  }
  return { offset: cursor, hadTrailingLine, trailingLineStart };
}

function readFirstJsonlEntry(fs, filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(FIRST_JSONL_ENTRY_CHUNK_BYTES);
    const chunks = [];
    let cursor = 0;
    while (cursor < FIRST_JSONL_ENTRY_MAX_BYTES) {
      const length = Math.min(buffer.length, FIRST_JSONL_ENTRY_MAX_BYTES - cursor);
      const bytesRead = fs.readSync(fd, buffer, 0, length, cursor);
      if (!bytesRead) break;
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      const newlineIndex = chunk.indexOf(0x0a);
      chunks.push(newlineIndex >= 0 ? chunk.subarray(0, newlineIndex) : chunk);
      cursor += bytesRead;
      if (newlineIndex >= 0 || bytesRead < length) break;
    }
    if (chunks.length === 0) return null;
    return safeParseJson(Buffer.concat(chunks).toString('utf8').replace(/\r$/, ''));
  } catch (_error) {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_error) {}
    }
  }
}

function isCodexForkSessionMeta(payload = {}) {
  if (!payload || typeof payload !== 'object') return false;
  if (String(payload.forked_from_id || '').trim()) return true;
  return Boolean(
    payload.source
    && payload.source.subagent
    && payload.source.subagent.thread_spawn
    && String(payload.source.subagent.thread_spawn.parent_thread_id || '').trim()
  );
}

function basenameWithoutExt(path, filePath) {
  const base = path.basename(String(filePath || ''));
  return base.replace(/\.[^.]+$/, '');
}

function inferProjectFromCwd(path, cwd, fallback = '') {
  const normalized = String(cwd || '').trim();
  if (normalized) return path.basename(normalized);
  return String(fallback || '').trim();
}

function buildFileEventKey(provider, filePath, lineOffset, kind) {
  return `${provider}:file:${stableHash(filePath)}:${Number(lineOffset) || 0}:${kind}`;
}

function buildClaudeUsageEventKey(message, filePath, lineOffset) {
  const messageId = String(message && message.id || '').trim();
  return messageId
    ? `claude:message:${messageId}`
    : buildFileEventKey('claude', filePath, lineOffset, 'usage');
}

function isCodexUserPrompt(payload = {}) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.type === 'user_message') return Boolean(String(payload.message || '').trim());
  if (payload.type !== 'message' || payload.role !== 'user') return false;
  if (payload.type === 'function_call_output') return false;
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content.some((block) => {
    if (!block || typeof block !== 'object') return false;
    const text = String(block.text || '').trim();
    return Boolean(text);
  });
}

function scanCodexFile({
  fs,
  path,
  store,
  filePath,
  reindexCodexForkHistory = false
}) {
  const stat = fs.statSync(filePath);
  const currentState = store.getFileState(filePath);
  const storedContext = currentState.scanContext && typeof currentState.scanContext === 'object'
    ? currentState.scanContext
    : {};
  const storedContextVersion = Number(storedContext.codexScanContextVersion) || 0;
  const deferredContextVersion = Number(storedContext.codexForkReindexDeferredVersion) || 0;
  const hasHistoricalOffset = Number(currentState.offset) > 0;
  const forkReindexAlreadyDeferred = hasHistoricalOffset
    && storedContextVersion !== CODEX_SCAN_CONTEXT_VERSION
    && deferredContextVersion === CODEX_SCAN_CONTEXT_VERSION;
  const firstEntry = storedContextVersion === CODEX_SCAN_CONTEXT_VERSION
    || forkReindexAlreadyDeferred
    ? null
    : readFirstJsonlEntry(fs, filePath);
  const firstPayload = firstEntry && firstEntry.type === 'session_meta'
    && firstEntry.payload && typeof firstEntry.payload === 'object'
    ? firstEntry.payload
    : null;
  const requiresForkProjectionRebuild = Boolean(
    hasHistoricalOffset
    && storedContextVersion !== CODEX_SCAN_CONTEXT_VERSION
    && (forkReindexAlreadyDeferred || isCodexForkSessionMeta(firstPayload))
  );
  if (requiresForkProjectionRebuild && !reindexCodexForkHistory) {
    if (!forkReindexAlreadyDeferred) {
      store.setFileState(filePath, {
        size: stat.size,
        offset: currentState.offset,
        scanContext: {
          ...storedContext,
          codexForkReindexDeferredVersion: CODEX_SCAN_CONTEXT_VERSION
        }
      });
    }
    return {
      records: 0,
      prompts: 0,
      filesDeferred: 1,
      reindexRequired: 1,
      reason: 'codex_fork_reindex_required'
    };
  }
  const rebuildForkProjection = requiresForkProjectionRebuild && reindexCodexForkHistory;
  const startOffset = stat.size < currentState.offset || rebuildForkProjection
    ? 0
    : currentState.offset;
  const ctx = startOffset > 0 && currentState.scanContext ? currentState.scanContext : {};
  let sessionId = String(ctx.sessionId || '').trim();
  let cwd = String(ctx.cwd || '').trim();
  let version = String(ctx.version || '').trim();
  let model = String(ctx.model || '').trim();
  let startedAtMs = Number(ctx.startedAtMs) || 0;
  let updatedAtMs = Number(ctx.updatedAtMs) || 0;
  const usageTracker = createCodexUsageTracker(ctx);
  let sessionMetaSeen = ctx.codexSessionMetaSeen === true || Boolean(sessionId);
  let forkSession = ctx.codexForkSession === true;
  let forkReplayPending = ctx.codexForkReplayPending === true;
  let forkStartedAtMs = Number(ctx.codexForkStartedAtMs) || 0;
  let forkReplayBoundaryOffset = Number(ctx.codexForkReplayBoundaryOffset) || 0;
  let forkPendingModel = String(ctx.codexForkPendingModel || '').trim();
  let promptCount = 0;
  const records = [];
  const promptEvents = [];

  function activateForkChild(lineOffset, fallbackModel = '') {
    forkReplayPending = false;
    forkReplayBoundaryOffset = Math.max(0, Number(lineOffset) || 0);
    model = String(fallbackModel || '').trim();
    forkPendingModel = '';
    resetCodexUsageTracker(usageTracker);
  }

  readJsonlFromOffset(fs, filePath, startOffset, (line, lineOffset) => {
    const entry = safeParseJson(line);
    if (!entry || typeof entry !== 'object') return;
    const timestampMs = toTimestampMs(entry.timestamp);
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};

    if (entry.type === 'session_meta') {
      if (sessionMetaSeen) return;
      sessionId = String(payload.id || sessionId || '').trim();
      cwd = String(payload.cwd || cwd || '').trim();
      version = String(payload.cli_version || payload.cliVersion || version || '').trim();
      sessionMetaSeen = true;
      forkSession = isCodexForkSessionMeta(payload);
      forkReplayPending = forkSession;
      forkStartedAtMs = parseUuidV7Timestamp(sessionId) || timestampMs;
      if (timestampMs) {
        startedAtMs = timestampMs;
        updatedAtMs = timestampMs;
      }
      return;
    }

    if (forkReplayPending) {
      if (entry.type === 'turn_context') {
        forkPendingModel = String(payload.model || forkPendingModel || '').trim();
        return;
      }
      const taskTurnId = entry.type === 'event_msg' && payload.type === 'task_started'
        ? String(payload.turn_id || entry.turn_id || '').trim()
        : '';
      const taskStartedAtMs = parseUuidV7Timestamp(taskTurnId);
      if (taskStartedAtMs && forkStartedAtMs && taskStartedAtMs >= forkStartedAtMs) {
        activateForkChild(lineOffset);
        return;
      }
      if (
        entry.type === 'inter_agent_communication_metadata'
        && payload.trigger_turn === true
      ) {
        activateForkChild(lineOffset, forkPendingModel);
      }
      return;
    }

    if (timestampMs) {
      if (!startedAtMs || timestampMs < startedAtMs) startedAtMs = timestampMs;
      if (timestampMs > updatedAtMs) updatedAtMs = timestampMs;
    }

    if (entry.type === 'turn_context') {
      model = String(payload.model || model || '').trim();
      return;
    }

    if (entry.type === 'response_item' && isCodexUserPrompt(payload)) {
      promptCount += 1;
      if (timestampMs) {
        promptEvents.push({
          provider: 'codex',
          sessionId,
          timestampMs,
          eventKey: buildFileEventKey('codex', filePath, lineOffset, 'prompt')
        });
      }
      return;
    }

    if (entry.type !== 'event_msg' || payload.type !== 'token_count') return;
    const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
    if (!timestampMs) return;
    const usage = observeCodexUsage(
      usageTracker,
      info.total_token_usage,
      info.last_token_usage
    );
    if (!usage || !model) return;
    records.push({
      eventKey: buildFileEventKey('codex', filePath, lineOffset, 'usage'),
      provider: 'codex',
      sourceKind: 'session_jsonl',
      sessionId,
      model,
      inputTokens: Math.max(0, usage.inputTokens - usage.cacheReadInputTokens),
      outputTokens: Math.max(0, usage.outputTokens - usage.reasoningOutputTokens),
      cacheReadInputTokens: usage.cacheReadInputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      totalTokens: usage.totalTokens,
      timestampMs,
      cwd,
      project: inferProjectFromCwd(path, cwd)
    });
  });

  if (!sessionId) sessionId = basenameWithoutExt(path, filePath);
  records.forEach((record) => {
    if (!record.sessionId) record.sessionId = sessionId;
    if (!record.cwd) record.cwd = cwd;
    if (!record.project) record.project = inferProjectFromCwd(path, cwd);
  });
  promptEvents.forEach((event) => {
    if (!event.sessionId) event.sessionId = sessionId;
  });

  const sessionRecords = sessionId && (records.length > 0 || promptCount > 0 || cwd)
    ? [{
      provider: 'codex',
      sessionId,
      cwd,
      project: inferProjectFromCwd(path, cwd),
      startedAtMs,
      updatedAtMs,
      promptCount
    }]
    : [];
  const fileState = {
    size: stat.size,
    offset: stat.size,
    scanContext: {
      sessionId, cwd, version, model, startedAtMs, updatedAtMs,
      codexScanContextVersion: CODEX_SCAN_CONTEXT_VERSION,
      codexSessionMetaSeen: sessionMetaSeen,
      codexForkSession: forkSession,
      codexForkReplayPending: forkReplayPending,
      codexForkStartedAtMs: forkStartedAtMs,
      codexForkReplayBoundaryOffset: forkReplayBoundaryOffset,
      codexForkPendingModel: forkPendingModel,
      codexForkSourceHash: forkSession ? stableHash(filePath) : '',
      codexForkCanonicalSessionId: forkSession ? sessionId : '',
      codexForkCanonicalCwd: forkSession ? cwd : '',
      codexForkCanonicalProject: forkSession ? inferProjectFromCwd(path, cwd) : '',
      codexUsageBaselines: usageTracker.baselines,
      codexUsageEventSignatures: usageTracker.recentEvents
    }
  };
  if (rebuildForkProjection) {
    const rebuilt = store.replaceFileProjection({
      provider: 'codex',
      sourceHash: stableHash(filePath),
      filePath,
      usageRecords: records,
      promptEvents,
      sessionRecords,
      fileState
    });
    return { records: rebuilt.records, prompts: rebuilt.prompts };
  }

  const inserted = store.insertUsageBatch(records);
  const promptsInserted = store.insertPromptEvents(promptEvents);
  if (sessionRecords.length > 0) {
    store.upsertSessions(sessionRecords);
  }
  store.setFileState(filePath, fileState);
  return { records: inserted, prompts: promptsInserted };
}

function hasClaudeToolResultBlock(content) {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== 'object') return false;
    return block.type === 'tool_result' || Boolean(block.tool_use_id);
  });
}

function isClaudeRealUserPrompt(message = {}) {
  const content = message && message.content;
  if (typeof content === 'string') return Boolean(content.trim());
  if (!Array.isArray(content) || content.length === 0) return false;
  if (hasClaudeToolResultBlock(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== 'object') return false;
    if (block.type === 'text') return Boolean(String(block.text || '').trim());
    return false;
  });
}

function scanClaudeFile({ fs, path, store, filePath }) {
  const stat = fs.statSync(filePath);
  const currentState = store.getFileState(filePath);
  const startOffset = stat.size < currentState.offset ? 0 : currentState.offset;
  const projectDir = path.basename(path.dirname(filePath));
  let sessionId = basenameWithoutExt(path, filePath);
  let cwd = '';
  let gitBranch = '';
  let version = '';
  let startedAtMs = 0;
  let updatedAtMs = 0;
  let promptCount = 0;
  const records = [];
  const promptEvents = [];

  readJsonlFromOffset(fs, filePath, startOffset, (line, lineOffset) => {
    const entry = safeParseJson(line);
    if (!entry || typeof entry !== 'object') return;
    const timestampMs = toTimestampMs(entry.timestamp);
    if (timestampMs) {
      if (!startedAtMs || timestampMs < startedAtMs) startedAtMs = timestampMs;
      if (timestampMs > updatedAtMs) updatedAtMs = timestampMs;
    }
    sessionId = String(entry.sessionId || sessionId || '').trim();
    cwd = String(entry.cwd || cwd || '').trim();
    gitBranch = String(entry.gitBranch || gitBranch || '').trim();
    version = String(entry.version || version || '').trim();
    const message = entry.message && typeof entry.message === 'object' ? entry.message : {};

    if (entry.type === 'user' && isClaudeRealUserPrompt(message)) {
      promptCount += 1;
      if (timestampMs) {
        promptEvents.push({
          provider: 'claude',
          sessionId,
          timestampMs,
          eventKey: buildFileEventKey('claude', filePath, lineOffset, 'prompt')
        });
      }
      return;
    }

    if (entry.type !== 'assistant') return;
    const usage = message.usage && typeof message.usage === 'object' ? message.usage : null;
    if (!usage || !timestampMs) return;
    const model = String(message.model || '').trim();
    if (!model || model === '<synthetic>' || model === 'delivery-mirror') return;
    const input = toInt(usage.input_tokens);
    const output = toInt(usage.output_tokens);
    const cacheCreate = toInt(usage.cache_creation_input_tokens);
    const cacheRead = toInt(usage.cache_read_input_tokens);
    if (!input && !output && !cacheCreate && !cacheRead) return;
    records.push({
      eventKey: buildClaudeUsageEventKey(message, filePath, lineOffset),
      provider: 'claude',
      sourceKind: 'session_jsonl',
      sessionId,
      model,
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreate,
      totalTokens: input + output + cacheRead + cacheCreate,
      timestampMs,
      project: inferProjectFromCwd(path, cwd, projectDir),
      cwd,
      gitBranch
    });
  });

  const inserted = store.insertUsageBatch(records);
  const promptsInserted = store.insertPromptEvents(promptEvents);
  if (sessionId && (records.length > 0 || promptCount > 0 || cwd)) {
    store.upsertSessions([{
      provider: 'claude',
      sessionId,
      project: inferProjectFromCwd(path, cwd, projectDir),
      cwd,
      gitBranch,
      startedAtMs,
      updatedAtMs,
      promptCount,
      version
    }]);
  }
  store.setFileState(filePath, {
    size: stat.size,
    offset: stat.size,
    scanContext: { sessionId, cwd, gitBranch, version, startedAtMs, updatedAtMs }
  });
  return { records: inserted, prompts: promptsInserted };
}

function readGeminiProjectPath(fs, path, geminiDir, projectName) {
  const rootFile = path.join(geminiDir, 'history', projectName, '.project_root');
  if (!pathExists(fs, rootFile)) return '';
  try {
    return String(fs.readFileSync(rootFile, 'utf8') || '').trim();
  } catch (_error) {
    return '';
  }
}

function flattenGeminiMessages(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.messages)) return payload.messages;
  return [];
}

function scanGeminiFile({ fs, path, store, filePath, geminiDir }) {
  const stat = fs.statSync(filePath);
  const currentState = store.getFileState(filePath);
  if (stat.size <= currentState.size && stat.mtimeMs <= Number(currentState.scanContext && currentState.scanContext.mtimeMs || 0)) {
    return { records: 0, prompts: 0 };
  }
  const payload = safeParseJson(fs.readFileSync(filePath, 'utf8'));
  if (!payload || typeof payload !== 'object') {
    store.setFileState(filePath, { size: stat.size, offset: stat.size, scanContext: { mtimeMs: stat.mtimeMs } });
    return { records: 0, prompts: 0 };
  }
  const messages = flattenGeminiMessages(payload);
  if (messages.length === 0) {
    store.setFileState(filePath, { size: stat.size, offset: stat.size, scanContext: { mtimeMs: stat.mtimeMs } });
    return { records: 0, prompts: 0 };
  }

  const sessionId = String(payload.sessionId || basenameWithoutExt(path, filePath)).trim();
  const parts = String(filePath).split(path.sep);
  const tmpIndex = parts.lastIndexOf('tmp');
  const projectName = tmpIndex >= 0 && parts[tmpIndex + 1] ? parts[tmpIndex + 1] : '';
  const cwd = readGeminiProjectPath(fs, path, geminiDir, projectName);
  const records = [];
  const promptEvents = [];
  let startedAtMs = toTimestampMs(payload.startTime);
  let updatedAtMs = toTimestampMs(payload.lastUpdated);
  let promptCount = 0;

  messages.forEach((message, index) => {
    if (!message || typeof message !== 'object') return;
    const timestampMs = toTimestampMs(message.timestamp);
    if (timestampMs) {
      if (!startedAtMs || timestampMs < startedAtMs) startedAtMs = timestampMs;
      if (timestampMs > updatedAtMs) updatedAtMs = timestampMs;
    }
    if (message.type === 'user') {
      promptCount += 1;
      if (timestampMs) {
        promptEvents.push({
          provider: 'gemini',
          sessionId,
          timestampMs,
          eventKey: `gemini:file:${stableHash(filePath)}:${index}:prompt:${stableHash(message.id || timestampMs)}`
        });
      }
      return;
    }
    if (message.type !== 'gemini') return;
    const tokens = message.tokens && typeof message.tokens === 'object' ? message.tokens : null;
    if (!tokens || !timestampMs) return;
    const input = toInt(tokens.input);
    const output = toInt(tokens.output);
    const cached = toInt(tokens.cached);
    const thoughts = toInt(tokens.thoughts);
    const total = toInt(tokens.total) || input + output + cached + thoughts + toInt(tokens.tool);
    if (!input && !output && !cached && !thoughts && !total) return;
    records.push({
      eventKey: `gemini:file:${stableHash(filePath)}:${index}:usage:${stableHash(message.id || timestampMs)}`,
      provider: 'gemini',
      sourceKind: 'session_json',
      sessionId,
      model: String(message.model || '').trim(),
      inputTokens: Math.max(0, input - cached),
      outputTokens: output,
      cacheReadInputTokens: cached,
      reasoningOutputTokens: thoughts,
      totalTokens: total,
      timestampMs,
      project: inferProjectFromCwd(path, cwd, projectName),
      cwd
    });
  });

  const inserted = store.insertUsageBatch(records);
  const promptsInserted = store.insertPromptEvents(promptEvents);
  if (sessionId && (records.length > 0 || promptCount > 0 || cwd)) {
    store.upsertSessions([{
      provider: 'gemini',
      sessionId,
      project: inferProjectFromCwd(path, cwd, projectName),
      cwd,
      startedAtMs,
      updatedAtMs,
      promptCount
    }]);
  }
  store.setFileState(filePath, {
    size: stat.size,
    offset: stat.size,
    scanContext: { mtimeMs: stat.mtimeMs, sessionId, updatedAtMs }
  });
  return { records: inserted, prompts: promptsInserted };
}

let resolvedDatabaseSync = null;
let didResolveDatabaseSync = false;

function getDatabaseSyncCtor(options = {}) {
  if (options && options.DatabaseSync) return options.DatabaseSync;
  if (didResolveDatabaseSync) return resolvedDatabaseSync;
  didResolveDatabaseSync = true;
  try {
    ({ DatabaseSync: resolvedDatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    resolvedDatabaseSync = null;
  }
  return resolvedDatabaseSync;
}

function hasSqliteTable(db, tableName) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(tableName);
    return Boolean(row && row.name);
  } catch (_error) {
    return false;
  }
}

function discoverOpenCodeUsageFiles({ fs, path, hostHomeDir, aiHomeDir }) {
  const files = [];
  const seenPaths = new Set();

  function addDbCandidate(candidatePath) {
    if (!candidatePath || !pathExists(fs, candidatePath)) return;
    try {
      let real = candidatePath;
      try {
        real = fs.realpathSync(candidatePath);
      } catch (_e) {}
      if (seenPaths.has(real) || seenPaths.has(candidatePath)) return;
      if (!fs.statSync(candidatePath).isFile()) return;
      seenPaths.add(real);
      seenPaths.add(candidatePath);
      files.push(candidatePath);
    } catch (_error) {}
  }

  const canonicalDb = path.join(hostHomeDir, '.local', 'share', 'opencode', 'opencode.db');
  addDbCandidate(canonicalDb);

  const conflictRoot = path.join(hostHomeDir, '.local', 'share', 'opencode', '.aih-migration-conflicts');
  if (pathExists(fs, conflictRoot)) {
    const conflictFiles = listFilesRecursive(fs, path, conflictRoot, (_full, name) => /^opencode\.db(?:\.\d+)?$/.test(name));
    conflictFiles.forEach(addDbCandidate);
  }

  const projectionsRoot = aiHomeDir ? path.join(aiHomeDir, 'run', 'auth-projections', 'opencode') : '';
  if (projectionsRoot && pathExists(fs, projectionsRoot)) {
    const projectionFiles = listFilesRecursive(fs, path, projectionsRoot, (_full, name) => /^opencode\.db(?:\.\d+)?$/.test(name));
    projectionFiles.forEach(addDbCandidate);
  }

  return files;
}

function parseOpenCodeMessageModel(data, sessionModelRaw) {
  if (data && data.modelID) {
    const providerID = String(data.providerID || '').trim();
    const modelID = String(data.modelID || '').trim();
    if (providerID && !modelID.startsWith(`${providerID}/`)) {
      return `${providerID}/${modelID}`;
    }
    return modelID;
  }
  if (data && typeof data.model === 'string') {
    return data.model.trim();
  }
  if (data && data.model && typeof data.model === 'object') {
    const providerID = String(data.model.providerID || data.model.providerId || '').trim();
    const modelID = String(data.model.id || data.model.modelID || data.model.modelId || '').trim();
    if (providerID && !modelID.startsWith(`${providerID}/`)) {
      return `${providerID}/${modelID}`;
    }
    return modelID;
  }
  if (sessionModelRaw) {
    const parsedSessionModel = safeParseJson(sessionModelRaw);
    if (parsedSessionModel && typeof parsedSessionModel === 'object') {
      const providerID = String(parsedSessionModel.providerID || parsedSessionModel.providerId || '').trim();
      const modelID = String(parsedSessionModel.id || parsedSessionModel.modelID || '').trim();
      if (providerID && !modelID.startsWith(`${providerID}/`)) {
        return `${providerID}/${modelID}`;
      }
      return modelID;
    }
    if (typeof sessionModelRaw === 'string') {
      return sessionModelRaw.trim();
    }
  }
  return '';
}

function scanOpenCodeFile({ fs, path, store, filePath, DatabaseSync }) {
  if (!pathExists(fs, filePath)) return { records: 0, prompts: 0 };
  const stat = fs.statSync(filePath);
  const currentState = store.getFileState(filePath);
  if (stat.size <= currentState.size && stat.mtimeMs <= Number(currentState.scanContext && currentState.scanContext.mtimeMs || 0)) {
    return { records: 0, prompts: 0 };
  }

  const DatabaseSyncCtor = getDatabaseSyncCtor({ DatabaseSync });
  if (!DatabaseSyncCtor) {
    return { records: 0, prompts: 0 };
  }

  let db = null;
  try {
    db = new DatabaseSyncCtor(filePath, { readOnly: true });
    db.exec('PRAGMA query_only = ON;');
  } catch (error) {
    store.setFileState(filePath, {
      size: stat.size,
      offset: stat.size,
      scanContext: { mtimeMs: stat.mtimeMs, error: String(error && error.message || error) }
    });
    return { records: 0, prompts: 0 };
  }

  try {
    if (!hasSqliteTable(db, 'session') || !hasSqliteTable(db, 'message')) {
      store.setFileState(filePath, {
        size: stat.size,
        offset: stat.size,
        scanContext: { mtimeMs: stat.mtimeMs }
      });
      return { records: 0, prompts: 0 };
    }

    const hasProjectTable = hasSqliteTable(db, 'project');
    const querySql = hasProjectTable
      ? `
        SELECT
          message.id AS message_id,
          message.session_id AS session_id,
          message.time_created AS message_time_created,
          message.time_updated AS message_time_updated,
          message.data AS message_data,
          session.project_id AS session_project_id,
          session.directory AS session_directory,
          session.path AS session_path,
          session.title AS session_title,
          session.model AS session_model,
          session.version AS session_version,
          session.time_created AS session_time_created,
          session.time_updated AS session_time_updated,
          project.worktree AS project_worktree,
          project.name AS project_name
        FROM message
        LEFT JOIN session ON session.id = message.session_id
        LEFT JOIN project ON project.id = session.project_id
        ORDER BY message.time_created ASC, message.id ASC
      `
      : `
        SELECT
          message.id AS message_id,
          message.session_id AS session_id,
          message.time_created AS message_time_created,
          message.time_updated AS message_time_updated,
          message.data AS message_data,
          session.project_id AS session_project_id,
          session.directory AS session_directory,
          session.path AS session_path,
          session.title AS session_title,
          session.model AS session_model,
          session.version AS session_version,
          session.time_created AS session_time_created,
          session.time_updated AS session_time_updated,
          NULL AS project_worktree,
          NULL AS project_name
        FROM message
        LEFT JOIN session ON session.id = message.session_id
        ORDER BY message.time_created ASC, message.id ASC
      `;
    const rows = db.prepare(querySql).all();

    const records = [];
    const promptEvents = [];
    const sessionsById = new Map();

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const messageId = String(row && row.message_id || '').trim();
      const sessionId = String(row && row.session_id || '').trim();
      if (!sessionId) continue;
      const data = safeParseJson(row && row.message_data);
      if (!data || typeof data !== 'object') continue;

      const messageCreatedAt = toTimestampMs(data.time && data.time.created) || Number(row.message_time_created) || 0;
      const messageCompletedAt = toTimestampMs(data.time && (data.time.completed || data.time.created)) || Number(row.message_time_updated) || messageCreatedAt;
      const timestampMs = messageCompletedAt || messageCreatedAt;

      let sessionInfo = sessionsById.get(sessionId);
      if (!sessionInfo) {
        const cwd = String(
          (data.path && (data.path.cwd || data.path.root))
          || row.session_directory
          || row.session_path
          || row.project_worktree
          || ''
        ).trim();
        const sessionStarted = toTimestampMs(row.session_time_created) || messageCreatedAt;
        const sessionUpdated = toTimestampMs(row.session_time_updated) || messageCompletedAt;
        sessionInfo = {
          sessionId,
          cwd,
          project: inferProjectFromCwd(path, cwd, String(row.project_name || row.session_title || '').trim()),
          gitBranch: '',
          startedAtMs: sessionStarted,
          updatedAtMs: sessionUpdated,
          promptCount: 0,
          version: String(row.session_version || 'opencode').trim()
        };
        sessionsById.set(sessionId, sessionInfo);
      }
      if (timestampMs) {
        if (!sessionInfo.startedAtMs || timestampMs < sessionInfo.startedAtMs) {
          sessionInfo.startedAtMs = timestampMs;
        }
        if (timestampMs > sessionInfo.updatedAtMs) {
          sessionInfo.updatedAtMs = timestampMs;
        }
      }

      const role = String(data.role || '').trim().toLowerCase();
      if (role === 'user') {
        sessionInfo.promptCount += 1;
        if (timestampMs) {
          promptEvents.push({
            provider: 'opencode',
            sessionId,
            timestampMs,
            eventKey: messageId
              ? `opencode:prompt:${messageId}`
              : `opencode:file:${stableHash(filePath)}:${index}:prompt:${stableHash(messageCreatedAt)}`
          });
        }
        continue;
      }

      if (role !== 'assistant') continue;

      const tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : {};
      const input = toInt(tokens.input ?? tokens.prompt_tokens ?? tokens.input_tokens ?? data.input_tokens);
      const output = toInt(tokens.output ?? tokens.completion_tokens ?? tokens.output_tokens ?? data.output_tokens);
      const reasoning = toInt(tokens.reasoning ?? tokens.reasoning_tokens ?? data.reasoning_tokens);
      const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
      const cacheRead = toInt(cache.read ?? tokens.cache_read ?? tokens.cache_read_tokens ?? data.cache_read_tokens);
      const cacheWrite = toInt(cache.write ?? tokens.cache_write ?? tokens.cache_write_tokens ?? data.cache_write_tokens);
      const total = toInt(tokens.total ?? tokens.total_tokens ?? data.total_tokens) || (input + output + reasoning + cacheRead + cacheWrite);

      if (!input && !output && !reasoning && !cacheRead && !cacheWrite && !total) continue;

      const model = parseOpenCodeMessageModel(data, row.session_model);
      if (!model || model === '<synthetic>' || model === 'delivery-mirror') continue;

      records.push({
        eventKey: messageId
          ? `opencode:message:${messageId}`
          : `opencode:file:${stableHash(filePath)}:${index}:usage:${stableHash(timestampMs)}`,
        provider: 'opencode',
        sourceKind: 'session_db',
        sessionId,
        model,
        inputTokens: Math.max(0, input - cacheRead),
        outputTokens: output,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheWrite,
        reasoningOutputTokens: reasoning,
        totalTokens: total,
        timestampMs,
        project: sessionInfo.project,
        cwd: sessionInfo.cwd,
        gitBranch: sessionInfo.gitBranch || ''
      });
    }

    try {
      const sessionRows = db.prepare('SELECT id, directory, path, title, version, time_created, time_updated FROM session').all();
      for (const sRow of sessionRows) {
        const sId = String(sRow.id || '').trim();
        if (!sId || sessionsById.has(sId)) continue;
        const cwd = String(sRow.directory || sRow.path || '').trim();
        const title = String(sRow.title || '').trim();
        sessionsById.set(sId, {
          sessionId: sId,
          cwd,
          project: inferProjectFromCwd(path, cwd, title),
          gitBranch: '',
          startedAtMs: toTimestampMs(sRow.time_created) || 0,
          updatedAtMs: toTimestampMs(sRow.time_updated) || 0,
          promptCount: 0,
          version: String(sRow.version || 'opencode').trim()
        });
      }
    } catch (_sessionError) {}

    const inserted = store.insertUsageBatch(records);
    const promptsInserted = store.insertPromptEvents(promptEvents);
    if (sessionsById.size > 0) {
      store.upsertSessions(Array.from(sessionsById.values()).map((s) => ({
        provider: 'opencode',
        sessionId: s.sessionId,
        project: s.project,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        startedAtMs: s.startedAtMs,
        updatedAtMs: s.updatedAtMs,
        promptCount: s.promptCount,
        version: s.version
      })));
    }
    store.setFileState(filePath, {
      size: stat.size,
      offset: stat.size,
      scanContext: { mtimeMs: stat.mtimeMs, recordsCount: records.length, updatedAtMs: Date.now() }
    });
    return { records: inserted, prompts: promptsInserted };
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_closeErr) {}
    }
  }
}

function inferKimiSessionId(path, filePath) {
  const parts = String(filePath).split(path.sep);
  const agentsIndex = parts.lastIndexOf('agents');
  if (agentsIndex > 0 && parts[agentsIndex + 1] && parts[agentsIndex + 2] === 'wire.jsonl') {
    return String(parts[agentsIndex - 1] || '').trim();
  }
  return basenameWithoutExt(path, filePath);
}

function isKimiUserPrompt(entry = {}) {
  const origin = entry.origin && typeof entry.origin === 'object' ? entry.origin : {};
  return origin.kind === 'user';
}

// Kimi session storage is shared: account projections normally symlink their
// sessions directory to the host .kimi-code tree. Targets are discovery roots,
// not ownership evidence; session_index.jsonl is the ownership source of truth.
function discoverKimiUsageScanTargets({ fs, path, hostHomeDir, aiHomeDir }) {
  const targets = [{
    accountRef: '',
    sessionsRoot: path.join(hostHomeDir, '.kimi-code', 'sessions')
  }];
  const errors = [];
  const projectionsRoot = aiHomeDir
    ? path.join(aiHomeDir, 'run', 'auth-projections', 'kimi')
    : '';
  if (!projectionsRoot || !pathExists(fs, projectionsRoot)) return { targets, errors };
  let entries = [];
  try {
    entries = fs.readdirSync(projectionsRoot, { withFileTypes: true });
  } catch (error) {
    errors.push({
      code: 'projections_root_unreadable',
      path: projectionsRoot,
      message: String(error && error.code || error && error.message || '')
    });
    return { targets, errors };
  }
  entries.forEach((entry) => {
    if (!entry.isDirectory() || !isAccountRef(entry.name)) return;
    targets.push({
      accountRef: entry.name,
      sessionsRoot: path.join(projectionsRoot, entry.name, '.kimi-code', 'sessions')
    });
  });
  return { targets, errors };
}

function listKimiUsageScanTargets(options = {}) {
  return discoverKimiUsageScanTargets(options).targets;
}

function isPathWithinRoot(path, targetPath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function discoverKimiUsageFiles({ fs, path, targets = [] }) {
  const errors = [];
  const trustedTargets = [];
  const rootsByPhysicalPath = new Map();
  const normalizedTargets = Array.isArray(targets) ? targets : [];
  const hostTarget = normalizedTargets.find((target) => !String(target && target.accountRef || '').trim());
  const orderedTargets = hostTarget
    ? [hostTarget, ...normalizedTargets.filter((target) => target !== hostTarget)]
    : normalizedTargets;
  let physicalHostRoot = '';

  orderedTargets.forEach((target) => {
    const sessionsRoot = String(target && target.sessionsRoot || '').trim();
    if (!sessionsRoot || !pathExists(fs, sessionsRoot)) {
      errors.push({ code: 'sessions_root_missing', path: sessionsRoot });
      return;
    }
    let physicalRoot = '';
    try {
      physicalRoot = resolvePhysicalPath(fs, path, sessionsRoot);
      if (!fs.statSync(physicalRoot).isDirectory()) throw new Error('sessions_root_not_directory');
    } catch (error) {
      errors.push({
        code: 'sessions_root_unreadable',
        path: sessionsRoot,
        message: String(error && error.code || error && error.message || '')
      });
      return;
    }
    if (target === hostTarget) physicalHostRoot = physicalRoot;
    const accountRef = String(target && target.accountRef || '').trim();
    if (accountRef) {
      const runtimeRoot = path.dirname(sessionsRoot);
      try {
        const runtimeStat = fs.lstatSync(runtimeRoot);
        if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) {
          errors.push({ code: 'sessions_runtime_untrusted_symlink', path: runtimeRoot });
          return;
        }
      } catch (error) {
        errors.push({
          code: 'sessions_runtime_unreadable',
          path: runtimeRoot,
          message: String(error && error.code || error && error.message || '')
        });
        return;
      }
    }
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(sessionsRoot).isSymbolicLink();
    } catch (error) {
      errors.push({
        code: 'sessions_root_unreadable',
        path: sessionsRoot,
        message: String(error && error.code || error && error.message || '')
      });
      return;
    }
    if (accountRef && isSymlink && physicalRoot !== physicalHostRoot) {
      errors.push({ code: 'sessions_root_untrusted_symlink', path: sessionsRoot });
      return;
    }
    const trustedTarget = { ...target, sessionsRoot, physicalRoot };
    trustedTargets.push(trustedTarget);
    if (!rootsByPhysicalPath.has(physicalRoot)) {
      rootsByPhysicalPath.set(physicalRoot, { physicalRoot, targets: [] });
    }
    rootsByPhysicalPath.get(physicalRoot).targets.push(trustedTarget);
  });

  const filesByPhysicalPath = new Map();
  rootsByPhysicalPath.forEach((root) => {
    const stack = [root.physicalRoot];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        errors.push({
          code: 'sessions_directory_unreadable',
          path: dir,
          message: String(error && error.code || error && error.message || '')
        });
        continue;
      }
      entries.forEach((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          return;
        }
        if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) {
          errors.push({ code: 'sessions_nested_symlink_skipped', path: full });
          return;
        }
        if (!entry.isFile() || entry.name !== 'wire.jsonl') return;
        const physicalPath = resolvePhysicalPath(fs, path, full);
        const relativePath = path.relative(root.physicalRoot, physicalPath);
        if (!isPathWithinRoot(path, physicalPath, root.physicalRoot)) {
          errors.push({ code: 'wire_path_outside_root', path: full });
          return;
        }
        const sourcePaths = new Set([physicalPath]);
        root.targets.forEach((target) => {
          sourcePaths.add(path.join(target.sessionsRoot, relativePath));
        });
        if (!filesByPhysicalPath.has(physicalPath)) {
          filesByPhysicalPath.set(physicalPath, { filePath: physicalPath, sourcePaths });
          return;
        }
        sourcePaths.forEach((sourcePath) => filesByPhysicalPath.get(physicalPath).sourcePaths.add(sourcePath));
      });
    }
  });

  const entries = Array.from(filesByPhysicalPath.values())
    .sort((left, right) => left.filePath.localeCompare(right.filePath))
    .map((entry) => ({
      filePath: entry.filePath,
      sourcePaths: Array.from(entry.sourcePaths).sort((left, right) => left.localeCompare(right))
    }));
  return {
    entries,
    files: entries.map((entry) => entry.filePath),
    errors,
    trustedTargets
  };
}

function collectKimiUsageFiles(options = {}) {
  return discoverKimiUsageFiles(options).files;
}

function readKimiFileProjection({
  fs,
  path,
  filePath,
  accountRef = '',
  currentState = null,
  forceFull = false,
  strictSnapshot = false
}) {
  const stat = fs.statSync(filePath);
  const storedState = currentState && typeof currentState === 'object'
    ? currentState
    : { size: 0, offset: 0, scanContext: null };
  const storedContext = storedState.scanContext && typeof storedState.scanContext === 'object'
    ? storedState.scanContext
    : {};
  const hasStoredCursor = Number(storedState.offset) > 0;
  const sourceTruncated = !forceFull && hasStoredCursor && stat.size < storedState.offset;
  const storedSourceDev = String(storedContext.sourceDev ?? '').trim();
  const storedSourceIno = String(storedContext.sourceIno ?? '').trim();
  const sourceRotated = !forceFull
    && hasStoredCursor
    && storedSourceDev
    && storedSourceIno
    && (
      storedSourceDev !== String(stat.dev ?? '').trim()
      || storedSourceIno !== String(stat.ino ?? '').trim()
    );
  const sourceReset = sourceTruncated || sourceRotated;
  const startOffset = forceFull || sourceReset ? 0 : storedState.offset;
  const ctx = startOffset > 0 ? storedContext : {};
  const sessionId = String(ctx.sessionId || inferKimiSessionId(path, filePath)).trim();
  const attributedAccountRef = String(accountRef || '').trim();
  let cwd = String(ctx.cwd || '').trim();
  let startedAtMs = Number(ctx.startedAtMs) || 0;
  let updatedAtMs = Number(ctx.updatedAtMs) || 0;
  let promptCount = 0;
  const records = [];
  const promptEvents = [];
  let invalidJsonLines = 0;
  const invalidJsonOffsets = new Set();

  const readResult = readJsonlFromOffset(fs, filePath, startOffset, (line, lineOffset) => {
    const entry = safeParseJson(line);
    if (!entry || typeof entry !== 'object') {
      invalidJsonLines += 1;
      invalidJsonOffsets.add(lineOffset);
      return;
    }
    if (entry.type === 'metadata') {
      const createdAtMs = toTimestampMs(entry.created_at);
      if (createdAtMs && (!startedAtMs || createdAtMs < startedAtMs)) startedAtMs = createdAtMs;
      return;
    }
    const timestampMs = toTimestampMs(entry.time);
    if (timestampMs) {
      if (!startedAtMs || timestampMs < startedAtMs) startedAtMs = timestampMs;
      if (timestampMs > updatedAtMs) updatedAtMs = timestampMs;
    }

    if (entry.type === 'profile.bind') {
      const disclosure = entry.environmentDisclosure && typeof entry.environmentDisclosure === 'object'
        ? entry.environmentDisclosure
        : {};
      cwd = String(disclosure.cwd || cwd || '').trim();
      return;
    }

    if (entry.type === 'turn.prompt') {
      if (!isKimiUserPrompt(entry)) return;
      promptCount += 1;
      if (timestampMs) {
        promptEvents.push({
          provider: 'kimi',
          sessionId,
          timestampMs,
          eventKey: buildFileEventKey('kimi', filePath, lineOffset, 'prompt')
        });
      }
      return;
    }

    if (entry.type !== 'usage.record') return;
    // session-scope rows are cumulative snapshots; turn-scope rows are per-request actuals.
    if (String(entry.usageScope || '').trim() !== 'turn') return;
    if (!timestampMs) return;
    const usage = entry.usage && typeof entry.usage === 'object' ? entry.usage : null;
    if (!usage) return;
    const model = String(entry.model || '').trim();
    if (!model) return;
    const input = toInt(usage.inputOther);
    const output = toInt(usage.output);
    const cacheRead = toInt(usage.inputCacheRead);
    const cacheCreate = toInt(usage.inputCacheCreation);
    if (!input && !output && !cacheRead && !cacheCreate) return;
    records.push({
      eventKey: buildFileEventKey('kimi', filePath, lineOffset, 'usage'),
      provider: 'kimi',
      accountRef: attributedAccountRef,
      sourceKind: 'session_jsonl',
      sessionId,
      model,
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreate,
      totalTokens: input + output + cacheRead + cacheCreate,
      timestampMs,
      project: inferProjectFromCwd(path, cwd),
      cwd
    });
  });
  const finalStat = fs.statSync(filePath);
  const sourceChanged = Boolean(
    Number(stat.size) !== Number(finalStat.size)
    || Number(stat.mtimeMs) !== Number(finalStat.mtimeMs)
    || Number(stat.ctimeMs) !== Number(finalStat.ctimeMs)
    || (Number.isFinite(Number(stat.ino)) && Number(stat.ino) !== Number(finalStat.ino))
    || (Number.isFinite(Number(stat.dev)) && Number(stat.dev) !== Number(finalStat.dev))
  );
  const sourceErrors = [];
  if (strictSnapshot && sourceChanged) sourceErrors.push('source_changed');
  if (strictSnapshot && invalidJsonLines > 0) sourceErrors.push('invalid_jsonl');
  const safeOffset = readResult
    && readResult.hadTrailingLine
    && invalidJsonOffsets.has(readResult.trailingLineStart)
    ? readResult.trailingLineStart
    : Number(readResult && readResult.offset) || finalStat.size;

  const sessionRecords = sessionId && (records.length > 0 || promptCount > 0 || cwd)
    ? [{
      provider: 'kimi',
      sessionId,
      project: inferProjectFromCwd(path, cwd),
      cwd,
      startedAtMs,
      updatedAtMs,
      promptCount
    }]
    : [];
  return {
    records,
    promptEvents,
    sessionRecords,
    fileState: {
      filePath,
      size: finalStat.size,
      offset: safeOffset,
      scanContext: {
        sessionId,
        cwd,
        startedAtMs,
        updatedAtMs,
        attributedAccountRef,
        sourceDev: String(finalStat.dev ?? ''),
        sourceIno: String(finalStat.ino ?? '')
      }
    },
    sourceErrors,
    sourceReset
  };
}

function scanKimiFile({
  fs,
  path,
  store,
  filePath,
  accountRef = '',
  ownerAuthoritative = true
}) {
  const currentState = store.getFileState(filePath);
  const currentContext = currentState.scanContext && typeof currentState.scanContext === 'object'
    ? currentState.scanContext
    : {};
  const previousAccountRef = String(currentContext.attributedAccountRef || '').trim();
  const hasStoredProjection = Boolean(
    currentState.scanContext
    || Number(currentState.size) > 0
    || Number(currentState.offset) > 0
  );
  const requestedAccountRef = String(accountRef || '').trim();
  const effectiveAccountRef = hasStoredProjection && !ownerAuthoritative
    ? previousAccountRef
    : requestedAccountRef;
  const ownerChanged = ownerAuthoritative
    && hasStoredProjection
    && previousAccountRef !== effectiveAccountRef;
  const projection = readKimiFileProjection({
    fs,
    path,
    filePath,
    accountRef: effectiveAccountRef,
    currentState,
    forceFull: ownerChanged
  });
  if (ownerChanged || projection.sourceReset) {
    if (!store || typeof store.replaceKimiFileProjection !== 'function') {
      throw new Error('kimi_file_projection_replace_unavailable');
    }
    const rebuilt = store.replaceKimiFileProjection({
      sourceHash: stableHash(filePath),
      filePath,
      sessionId: projection.fileState.scanContext.sessionId,
      expectedFileState: currentState,
      usageRecords: projection.records,
      promptEvents: projection.promptEvents,
      sessionRecords: projection.sessionRecords,
      fileState: projection.fileState
    });
    return { records: rebuilt.records, prompts: rebuilt.prompts };
  }
  if (!store || typeof store.appendKimiFileProjection !== 'function') {
    throw new Error('kimi_file_projection_append_unavailable');
  }
  const appended = store.appendKimiFileProjection({
    sourceHash: stableHash(filePath),
    filePath,
    sessionId: projection.fileState.scanContext.sessionId,
    expectedFileState: currentState,
    usageRecords: projection.records,
    promptEvents: projection.promptEvents,
    sessionRecords: projection.sessionRecords,
    fileState: projection.fileState
  });
  return { records: appended.records, prompts: appended.prompts };
}

function mergeKimiSessionRecords(records = []) {
  const bySession = new Map();
  records.forEach((record) => {
    const sessionId = String(record && record.sessionId || '').trim();
    if (!sessionId) return;
    const existing = bySession.get(sessionId);
    if (!existing) {
      bySession.set(sessionId, { ...record });
      return;
    }
    existing.project = existing.project || record.project;
    existing.cwd = existing.cwd || record.cwd;
    existing.gitBranch = existing.gitBranch || record.gitBranch;
    const startedAtMs = Number(record.startedAtMs) || 0;
    if (startedAtMs && (!existing.startedAtMs || startedAtMs < existing.startedAtMs)) {
      existing.startedAtMs = startedAtMs;
    }
    existing.updatedAtMs = Math.max(Number(existing.updatedAtMs) || 0, Number(record.updatedAtMs) || 0);
    existing.promptCount = (Number(existing.promptCount) || 0) + (Number(record.promptCount) || 0);
  });
  return Array.from(bySession.values()).sort((left, right) => (
    left.sessionId.localeCompare(right.sessionId)
  ));
}

function buildKimiUsageProjection(options = {}) {
  const fs = options.fs;
  const path = options.path;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const targetDiscovery = discoverKimiUsageScanTargets({ fs, path, hostHomeDir, aiHomeDir });
  const discovery = discoverKimiUsageFiles({ fs, path, targets: targetDiscovery.targets });
  discovery.errors.unshift(...targetDiscovery.errors);
  const ownership = readKimiSessionOwnershipIndex({
    fs,
    path,
    hostHomeDir,
    aiHomeDir,
    trustedTargets: discovery.trustedTargets
  });
  const sourceErrors = [];
  const projections = [];
  discovery.entries.forEach((entry) => {
    try {
      const projection = readKimiFileProjection({
        fs,
        path,
        filePath: entry.filePath,
        accountRef: ownership.getAccountRef(entry.filePath),
        forceFull: true,
        strictSnapshot: true
      });
      projection.sourcePaths = entry.sourcePaths;
      projection.sourceErrors.forEach((code) => {
        sourceErrors.push({ code, path: entry.filePath });
      });
      projections.push(projection);
    } catch (error) {
      sourceErrors.push({
        code: 'source_read_failed',
        path: entry.filePath,
        message: String(error && error.code || error && error.message || '')
      });
    }
  });
  return {
    files: discovery.files,
    sourcePaths: Array.from(new Set(
      discovery.entries.flatMap((entry) => entry.sourcePaths)
    )).sort((left, right) => left.localeCompare(right)),
    records: projections.flatMap((projection) => projection.records),
    promptEvents: projections.flatMap((projection) => projection.promptEvents),
    sessionRecords: mergeKimiSessionRecords(
      projections.flatMap((projection) => projection.sessionRecords)
    ),
    fileStates: projections.map((projection) => projection.fileState),
    ownership,
    discoveryErrors: discovery.errors,
    sourceErrors
  };
}

function rebuildKimiUsageProjection(options = {}) {
  const store = options.store;
  const projection = buildKimiUsageProjection(options);
  const blockingReasons = [];
  if (projection.files.length === 0) blockingReasons.push('kimi_usage_rebuild_source_empty');
  if (projection.discoveryErrors.length > 0) {
    blockingReasons.push('kimi_usage_discovery_incomplete');
  }
  if (projection.ownership.indexPaths === 0) {
    blockingReasons.push('kimi_usage_index_unavailable');
  }
  if (projection.ownership.invalidEntries > 0) {
    blockingReasons.push('kimi_usage_index_invalid');
  }
  if (projection.ownership.ambiguousSessions > 0) {
    blockingReasons.push('kimi_usage_index_ambiguous');
  }
  if (projection.sourceErrors.some((error) => error.code === 'source_changed')) {
    blockingReasons.push('kimi_usage_source_changed');
  }
  if (projection.sourceErrors.some((error) => error.code !== 'source_changed')) {
    blockingReasons.push('kimi_usage_source_read_failed');
  }
  const uniqueBlockingReasons = Array.from(new Set(blockingReasons));
  const summary = {
    applied: false,
    canApply: uniqueBlockingReasons.length === 0,
    blockingReasons: uniqueBlockingReasons,
    files: projection.files.length,
    records: projection.records.length,
    prompts: projection.promptEvents.length,
    sessions: projection.sessionRecords.length,
    ambiguousSessions: projection.ownership.ambiguousSessions,
    invalidIndexEntries: projection.ownership.invalidEntries,
    discoveryErrors: projection.discoveryErrors.length,
    sourceErrors: projection.sourceErrors.length
  };
  if (options.apply !== true) return summary;
  if (!summary.canApply) {
    const error = new Error(`kimi_usage_rebuild_preflight_failed:${uniqueBlockingReasons.join(',')}`);
    error.code = 'kimi_usage_rebuild_preflight_failed';
    error.summary = summary;
    throw error;
  }
  if (!store || typeof store.replaceKimiTranscriptProjection !== 'function') {
    throw new Error('kimi_usage_rebuild_store_unavailable');
  }
  const replaced = store.replaceKimiTranscriptProjection({
    usageRecords: projection.records,
    promptEvents: projection.promptEvents,
    sessionRecords: projection.sessionRecords,
    fileStates: projection.fileStates,
    sourcePaths: projection.sourcePaths
  });
  return {
    ...summary,
    applied: true,
    deleted: replaced.deleted
  };
}

function addCounts(target, next) {
  target.files += Number(next.files) || 0;
  target.records += Number(next.records) || 0;
  target.prompts += Number(next.prompts) || 0;
  target.skipped += Number(next.skipped) || 0;
  target.filesDeferred += Number(next.filesDeferred) || 0;
  target.reindexRequired += Number(next.reindexRequired) || 0;
  return target;
}

function scanProviderFiles({ fs, path, store, files, scanFile }) {
  const out = {
    files: 0,
    records: 0,
    prompts: 0,
    skipped: 0,
    filesDeferred: 0,
    reindexRequired: 0
  };
  files.forEach((filePath) => {
    try {
      const result = scanFile(filePath) || {};
      out.files += 1;
      out.records += Number(result.records) || 0;
      out.prompts += Number(result.prompts) || 0;
      out.filesDeferred += Number(result.filesDeferred) || 0;
      out.reindexRequired += Number(result.reindexRequired) || 0;
    } catch (_error) {
      out.skipped += 1;
    }
  });
  if (out.reindexRequired > 0) {
    out.reason = 'codex_fork_reindex_required';
  }
  return out;
}

function scanModelUsageSources(options = {}) {
  const fs = options.fs;
  const path = options.path;
  const store = options.store;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  if (!fs || !path || !store || !hostHomeDir) {
    throw new Error('scanModelUsageSources requires fs/path/store/hostHomeDir.');
  }

  const providers = normalizeProviderFilter(options.providers);
  const result = {
    providers: {},
    files: 0,
    records: 0,
    prompts: 0,
    skipped: 0,
    filesDeferred: 0,
    reindexRequired: 0
  };

  if (providers.has('codex')) {
    const codexRoot = path.join(hostHomeDir, '.codex', 'sessions');
    const files = listFilesRecursive(fs, path, codexRoot, (_full, name) => name.endsWith('.jsonl'));
    const providerResult = scanProviderFiles({
      fs,
      path,
      store,
      files,
      scanFile: (filePath) => scanCodexFile({
        fs,
        path,
        store,
        filePath,
        reindexCodexForkHistory: options.reindexCodexForkHistory === true
      })
    });
    result.providers.codex = providerResult;
    addCounts(result, providerResult);
  }

  if (providers.has('claude')) {
    const claudeRoot = path.join(hostHomeDir, '.claude', 'projects');
    const files = listFilesRecursive(fs, path, claudeRoot, (_full, name) => name.endsWith('.jsonl'));
    const providerResult = scanProviderFiles({
      fs,
      path,
      store,
      files,
      scanFile: (filePath) => scanClaudeFile({ fs, path, store, filePath })
    });
    result.providers.claude = providerResult;
    addCounts(result, providerResult);
  }

  if (providers.has('gemini')) {
    const geminiDir = path.join(hostHomeDir, '.gemini');
    const geminiRoot = path.join(geminiDir, 'tmp');
    const files = listFilesRecursive(fs, path, geminiRoot, (full, name) => {
      if (!name.endsWith('.json')) return false;
      return String(full).includes(`${path.sep}chats${path.sep}`);
    });
    const providerResult = scanProviderFiles({
      fs,
      path,
      store,
      files,
      scanFile: (filePath) => scanGeminiFile({ fs, path, store, filePath, geminiDir })
    });
    result.providers.gemini = providerResult;
    addCounts(result, providerResult);
  }

  if (providers.has('kimi')) {
    const targetDiscovery = discoverKimiUsageScanTargets({
      fs,
      path,
      hostHomeDir,
      aiHomeDir: String(options.aiHomeDir || '').trim()
    });
    const discovery = discoverKimiUsageFiles({ fs, path, targets: targetDiscovery.targets });
    discovery.errors.unshift(...targetDiscovery.errors);
    const ownership = readKimiSessionOwnershipIndex({
      fs,
      path,
      hostHomeDir,
      aiHomeDir: String(options.aiHomeDir || '').trim(),
      trustedTargets: discovery.trustedTargets
    });
    const combined = scanProviderFiles({
      fs,
      path,
      store,
      files: discovery.files,
      scanFile: (filePath) => {
        const attribution = ownership.resolveAttribution(filePath);
        return scanKimiFile({
          fs,
          path,
          store,
          filePath,
          accountRef: attribution.accountRef,
          ownerAuthoritative: attribution.authoritative
        });
      }
    });
    combined.ambiguousSessions = ownership.ambiguousSessions;
    combined.invalidIndexEntries = ownership.invalidEntries;
    combined.discoveryErrors = discovery.errors.length;
    combined.ownershipTrusted = ownership.trustworthy && ownership.ambiguousSessions === 0;
    result.providers.kimi = combined;
    addCounts(result, combined);
  }

  if (providers.has('opencode')) {
    const files = discoverOpenCodeUsageFiles({
      fs,
      path,
      hostHomeDir,
      aiHomeDir: String(options.aiHomeDir || '').trim()
    });
    const providerResult = scanProviderFiles({
      fs,
      path,
      store,
      files,
      scanFile: (filePath) => scanOpenCodeFile({
        fs,
        path,
        store,
        filePath,
        DatabaseSync: options.DatabaseSync
      })
    });
    result.providers.opencode = providerResult;
    addCounts(result, providerResult);
  }

  if (providers.has('agy')) {
    result.providers.agy = {
      files: 0,
      records: 0,
      prompts: 0,
      skipped: 0,
      reason: 'agy_local_conversations_are_protobuf; use server-side usage recording'
    };
  }

  return result;
}

module.exports = {
  rebuildKimiUsageProjection,
  scanModelUsageSources,
  __private: {
    buildFileEventKey,
    buildKimiUsageProjection,
    collectKimiUsageFiles,
    discoverKimiUsageFiles,
    discoverKimiUsageScanTargets,
    discoverOpenCodeUsageFiles,
    isClaudeRealUserPrompt,
    isCodexUserPrompt,
    isKimiUserPrompt,
    listFilesRecursive,
    listKimiUsageScanTargets,
    readJsonlFromOffset,
    readKimiFileProjection,
    scanClaudeFile,
    scanCodexFile,
    scanGeminiFile,
    scanKimiFile,
    scanOpenCodeFile,
    toTimestampMs
  }
};
