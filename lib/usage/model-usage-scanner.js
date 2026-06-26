'use strict';

const crypto = require('node:crypto');

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

function toInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
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
  let pending = '';

  try {
    fd = fs.openSync(filePath, 'r');
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, cursor);
      if (!bytesRead) break;
      const chunk = buffer.toString('utf8', 0, bytesRead);
      const parts = (pending + chunk).split(/\n/);
      pending = parts.pop() || '';
      parts.forEach((part) => {
        const line = String(part || '').replace(/\r$/, '');
        const bytes = Buffer.byteLength(`${part}\n`);
        if (line.trim()) onLine(line, lineStart);
        lineStart += bytes;
      });
      cursor += bytesRead;
    }
    if (pending.trim()) onLine(pending.replace(/\r$/, ''), lineStart);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_error) {}
    }
  }
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
  return `${provider}:file:${String(filePath || '')}:${Number(lineOffset) || 0}:${kind}`;
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

function scanCodexFile({ fs, path, store, filePath }) {
  const stat = fs.statSync(filePath);
  const currentState = store.getFileState(filePath);
  const startOffset = stat.size < currentState.offset ? 0 : currentState.offset;
  const ctx = startOffset > 0 && currentState.scanContext ? currentState.scanContext : {};
  let sessionId = String(ctx.sessionId || '').trim();
  let cwd = String(ctx.cwd || '').trim();
  let version = String(ctx.version || '').trim();
  let model = String(ctx.model || '').trim();
  let startedAtMs = Number(ctx.startedAtMs) || 0;
  let updatedAtMs = Number(ctx.updatedAtMs) || 0;
  // codex reports cumulative token totals; we persist the running baseline across
  // incremental scans so each turn's delta is computed once (see token_count below).
  let prevTotalInput = Number(ctx.prevTotalInput) || 0;
  let prevTotalCached = Number(ctx.prevTotalCached) || 0;
  let prevTotalOutput = Number(ctx.prevTotalOutput) || 0;
  let prevTotalReasoning = Number(ctx.prevTotalReasoning) || 0;
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
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};

    if (entry.type === 'session_meta') {
      sessionId = String(payload.id || sessionId || '').trim();
      cwd = String(payload.cwd || cwd || '').trim();
      version = String(payload.cli_version || payload.cliVersion || version || '').trim();
      return;
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
    // codex re-emits token_count many times per turn (rate-limit pings), each
    // carrying the SAME last_token_usage — summing those multiplies a turn's usage
    // (~3x observed in real sessions). total_token_usage is the session running
    // total, so we record only its positive delta since the previous event: every
    // turn is counted once and duplicate emits collapse to a zero delta.
    const total = info.total_token_usage && typeof info.total_token_usage === 'object'
      ? info.total_token_usage
      : null;
    if (!total || !timestampMs) return;
    const curInput = toInt(total.input_tokens);
    const curCached = toInt(total.cached_input_tokens);
    const curOutput = toInt(total.output_tokens);
    const curReasoning = toInt(total.reasoning_output_tokens);
    // a cumulative counter moving backwards means codex reset it (new task /
    // context compaction) — restart the baseline from zero so the delta is the
    // post-reset usage rather than a spurious negative clamp.
    const reset = curInput < prevTotalInput || curOutput < prevTotalOutput
      || curReasoning < prevTotalReasoning || curCached < prevTotalCached;
    const dInput = Math.max(0, curInput - (reset ? 0 : prevTotalInput));
    const dCached = Math.max(0, curCached - (reset ? 0 : prevTotalCached));
    const dOutput = Math.max(0, curOutput - (reset ? 0 : prevTotalOutput));
    const dReasoning = Math.max(0, curReasoning - (reset ? 0 : prevTotalReasoning));
    prevTotalInput = curInput;
    prevTotalCached = curCached;
    prevTotalOutput = curOutput;
    prevTotalReasoning = curReasoning;
    if (!dInput && !dOutput && !dCached && !dReasoning) return;
    records.push({
      eventKey: buildFileEventKey('codex', filePath, lineOffset, 'usage'),
      provider: 'codex',
      sourceKind: 'session_jsonl',
      sessionId,
      model,
      inputTokens: Math.max(0, dInput - dCached),
      outputTokens: dOutput,
      cacheReadInputTokens: dCached,
      reasoningOutputTokens: dReasoning,
      totalTokens: dInput + dOutput + dReasoning,
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

  const inserted = store.insertUsageBatch(records);
  const promptsInserted = store.insertPromptEvents(promptEvents);
  if (sessionId && (records.length > 0 || promptCount > 0 || cwd)) {
    store.upsertSessions([{
      provider: 'codex',
      sessionId,
      cwd,
      project: inferProjectFromCwd(path, cwd),
      startedAtMs,
      updatedAtMs,
      promptCount
    }]);
  }
  store.setFileState(filePath, {
    size: stat.size,
    offset: stat.size,
    scanContext: {
      sessionId, cwd, version, model, startedAtMs, updatedAtMs,
      prevTotalInput, prevTotalCached, prevTotalOutput, prevTotalReasoning
    }
  });
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
      eventKey: buildFileEventKey('claude', filePath, lineOffset, 'usage'),
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

function stableHash(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
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
          eventKey: `gemini:file:${filePath}:${index}:prompt:${stableHash(message.id || timestampMs)}`
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
      eventKey: `gemini:file:${filePath}:${index}:usage:${stableHash(message.id || timestampMs)}`,
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
  return target;
}

function scanProviderFiles({ fs, path, store, files, scanFile }) {
  const out = { files: 0, records: 0, prompts: 0, skipped: 0 };
  files.forEach((filePath) => {
    try {
      const result = scanFile(filePath) || {};
      out.files += 1;
      out.records += Number(result.records) || 0;
      out.prompts += Number(result.prompts) || 0;
    } catch (_error) {
      out.skipped += 1;
    }
  });
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
    skipped: 0
  };

  if (providers.has('codex')) {
    const codexRoot = path.join(hostHomeDir, '.codex', 'sessions');
    const files = listFilesRecursive(fs, path, codexRoot, (_full, name) => name.endsWith('.jsonl'));
    const providerResult = scanProviderFiles({
      fs,
      path,
      store,
      files,
      scanFile: (filePath) => scanCodexFile({ fs, path, store, filePath })
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
    scanClaudeFile,
    scanCodexFile,
    scanGeminiFile,
    toTimestampMs
  }
};
