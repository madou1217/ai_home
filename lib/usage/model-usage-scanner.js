'use strict';

const { stableHash } = require('./model-usage-stable-hash');

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
  return set.size > 0 ? set : new Set(['codex', 'claude', 'gemini', 'agy', 'opencode']);
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
    if (pendingBytes > 0) emitLine();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_error) {}
    }
  }
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
  scanModelUsageSources,
  __private: {
    buildFileEventKey,
    isClaudeRealUserPrompt,
    isCodexUserPrompt,
    listFilesRecursive,
    readJsonlFromOffset,
    scanClaudeFile,
    scanCodexFile,
    scanGeminiFile,
    toTimestampMs
  }
};
