'use strict';

const crypto = require('node:crypto');
const {
  collectToolRequirementsFromDeclarations
} = require('../../../protocol/tool-call-validation');

const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 12;
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;
const DEFAULT_TEXT_LIMIT = 4000;

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeDiagnosticRelay(relay) {
  if (!relay || typeof relay !== 'object') return undefined;
  const kind = normalizeString(relay.kind || relay.type);
  const baseUrl = normalizeString(relay.baseUrl);
  const accountId = normalizeString(relay.accountId);
  const providerMode = normalizeString(relay.providerMode);
  const out = {
    ...(kind ? { kind } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(accountId ? { accountId } : {}),
    ...(providerMode ? { providerMode } : {})
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildDiagnosticIdentity(input = {}) {
  const provider = normalizeString(input.provider) || 'claude';
  const clientProvider = normalizeString(input.clientProvider) || provider;
  const upstreamProvider = normalizeString(input.upstreamProvider);
  const relay = normalizeDiagnosticRelay(input.relay);
  return {
    provider,
    clientProvider,
    ...(upstreamProvider ? { upstreamProvider } : {}),
    ...(relay ? { relay } : {})
  };
}

function truncateText(value, maxLength = DEFAULT_TEXT_LIMIT) {
  const text = String(value || '');
  const safeMax = Math.max(0, Number(maxLength) || DEFAULT_TEXT_LIMIT);
  if (text.length <= safeMax) return text;
  return `${text.slice(0, safeMax)}...`;
}

function sanitizeClaudeProjectDirName(projectPath) {
  return String(projectPath || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function containsClaudeStopHookJsonValidationError(outputText) {
  const text = String(outputText || '').toLowerCase();
  if (!text.includes('json validation failed')) return false;
  return text.includes('stop hook error') || text.includes('ran 1 stop hook') || text.includes('ran ') && text.includes(' stop hook');
}

function containsClaudeToolProtocolProblem(outputText) {
  const text = String(outputText || '').toLowerCase();
  return text.includes('[tool use interrupted]')
    || text.includes('inputvalidationerror')
    || text.includes('required parameter')
    || text.includes('string to replace not found in file')
    || text.includes('tool_use_error');
}

function readJsonlTail(fsImpl, filePath, maxBytes = DEFAULT_TAIL_BYTES) {
  let fd;
  try {
    const stats = fsImpl.statSync(filePath);
    const size = Number(stats && stats.size) || 0;
    if (size <= 0) return '';
    const bytesToRead = Math.min(size, Math.max(4096, Number(maxBytes) || DEFAULT_TAIL_BYTES));
    const start = Math.max(0, size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    fd = fsImpl.openSync(filePath, 'r');
    const bytesRead = fsImpl.readSync(fd, buffer, 0, bytesToRead, start);
    let text = buffer.toString('utf8', 0, bytesRead);
    if (start > 0) {
      const newlineIndex = text.indexOf('\n');
      text = newlineIndex >= 0 ? text.slice(newlineIndex + 1) : '';
    }
    return text;
  } catch (_error) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch (_error) {}
    }
  }
}

function safeParseJson(line) {
  try {
    return JSON.parse(line);
  } catch (_error) {
    return null;
  }
}

function parseTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = normalizeString(value);
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getRecordTimestampMs(record) {
  if (!record || typeof record !== 'object') return 0;
  return parseTimestampMs(record.timestamp);
}

function extractMessageText(record) {
  const content = record && record.message && record.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractMissingRequiredParameters(text) {
  const value = String(text || '');
  const missing = [];
  const patterns = [
    /required parameter\s+[`'"]?([a-zA-Z0-9_.-]+)[`'"]?\s+is missing/gi,
    /missing required parameter\s+[`'"]?([a-zA-Z0-9_.-]+)[`'"]?/gi
  ];
  patterns.forEach((pattern) => {
    for (const match of value.matchAll(pattern)) {
      const key = normalizeString(match && match[1]);
      if (key && !missing.includes(key)) missing.push(key);
    }
  });
  return missing;
}

function extractToolNameFromValidationText(text) {
  const value = String(text || '');
  const match = value.match(/InputValidationError:\s*([^\n:]+?)\s+failed\b/i);
  return normalizeString(match && match[1]);
}

function parseClaudeToolValidationText(text) {
  const value = String(text || '');
  if (!/InputValidationError/i.test(value) && !/required parameter/i.test(value) && !/tool_use_error/i.test(value)) {
    return null;
  }
  const toolName = extractToolNameFromValidationText(value);
  const missingRequired = extractMissingRequiredParameters(value);
  if (!toolName && missingRequired.length === 0) return null;
  return {
    ...(toolName ? { toolName } : {}),
    ...(missingRequired.length > 0 ? { missingRequired } : {})
  };
}

function containsClaudeEditStringNotFound(text) {
  return /string to replace not found in file/i.test(String(text || ''));
}

function hashDiagnosticText(value) {
  const text = String(value || '');
  if (!text) return '';
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function collectToolRequirementsFromRecord(record, requirements) {
  if (!record || typeof record !== 'object' || !(requirements instanceof Map)) return;
  [
    record.tools,
    record.toolSchemas,
    record.tool_schemas,
    record.request && record.request.tools,
    record.request && record.request.toolSchemas,
    record.request && record.request.tool_schemas,
    record.requestJson && record.requestJson.tools,
    record.params && record.params.tools,
    record.message && record.message.tools,
    record.message && record.message.toolSchemas,
    record.message && record.message.tool_schemas
  ].forEach((value) => collectToolRequirementsFromDeclarations(value, requirements));
}

function readRecordMessageContent(record) {
  const content = record && record.message && Array.isArray(record.message.content)
    ? record.message.content
    : [];
  return content.filter((part) => part && typeof part === 'object');
}

function readToolUseInputSummary(part) {
  const input = part && part.input && typeof part.input === 'object' && !Array.isArray(part.input)
    ? part.input
    : {};
  const oldString = typeof input.old_string === 'string' ? input.old_string : '';
  const newString = typeof input.new_string === 'string' ? input.new_string : '';
  return {
    toolName: normalizeString(part && part.name),
    toolUseId: normalizeString(part && part.id),
    filePath: normalizeString(input.file_path || input.path),
    ...(oldString ? { oldStringHash: hashDiagnosticText(oldString), oldStringLength: oldString.length } : {}),
    ...(newString ? { newStringLength: newString.length } : {})
  };
}

function collectToolUsesFromRecord(record, toolUses) {
  if (!(toolUses instanceof Map)) return;
  readRecordMessageContent(record).forEach((part) => {
    if (part.type !== 'tool_use') return;
    const toolUseId = normalizeString(part.id);
    if (!toolUseId) return;
    toolUses.set(toolUseId, readToolUseInputSummary(part));
  });
}

function readToolResultErrorText(part) {
  if (!part || part.type !== 'tool_result') return '';
  if (typeof part.content === 'string') return part.content;
  if (!Array.isArray(part.content)) return '';
  return part.content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      return normalizeString(item.text || item.content);
    })
    .filter(Boolean)
    .join('\n');
}

function collectEditStringNotFoundTexts(record) {
  const results = readRecordMessageContent(record)
    .filter((part) => part.type === 'tool_result')
    .map((part) => ({
      toolUseId: normalizeString(part.tool_use_id || part.toolUseId),
      text: readToolResultErrorText(part)
    }))
    .filter((item) => containsClaudeEditStringNotFound(item.text));
  if (results.length > 0) return results;

  const toolUseResult = normalizeString(record && record.toolUseResult);
  if (!containsClaudeEditStringNotFound(toolUseResult)) return [];
  return [{
    toolUseId: '',
    text: toolUseResult
  }];
}

function createEditStringNotFoundIncident(base, item, toolUses) {
  const toolUseId = normalizeString(item && item.toolUseId);
  const toolUse = toolUseId && toolUses instanceof Map ? toolUses.get(toolUseId) : null;
  const text = String(item && item.text || '');
  return {
    ...base,
    type: 'edit_string_not_found',
    toolName: normalizeString(toolUse && toolUse.toolName) || 'Edit',
    ...(toolUseId ? { toolUseId } : {}),
    ...(toolUse && toolUse.filePath ? { filePath: toolUse.filePath } : {}),
    ...(toolUse && toolUse.oldStringHash ? { oldStringHash: toolUse.oldStringHash } : {}),
    ...(toolUse && Number.isInteger(toolUse.oldStringLength) ? { oldStringLength: toolUse.oldStringLength } : {}),
    ...(toolUse && Number.isInteger(toolUse.newStringLength) ? { newStringLength: toolUse.newStringLength } : {}),
    triedUnicodeSwap: /edit also tried swapping/i.test(text),
    text: truncateText(text, 1200)
  };
}

function extractEditStringNotFoundIncidents(record, base, toolUses) {
  return collectEditStringNotFoundTexts(record)
    .map((item) => createEditStringNotFoundIncident(base, item, toolUses));
}

function extractClaudeToolProtocolIncidents(record, filePath, pathImpl, toolRequirements, toolUses) {
  if (!record || typeof record !== 'object') return [];
  const sessionId = normalizeString(record.sessionId) || pathImpl.basename(filePath, '.jsonl');
  const base = {
    sessionId,
    projectDirName: pathImpl.basename(pathImpl.dirname(filePath)),
    transcriptPath: filePath,
    timestamp: normalizeString(record.timestamp),
    timestampMs: getRecordTimestampMs(record),
    cwd: normalizeString(record.cwd),
    recordType: normalizeString(record.type),
    uuid: normalizeString(record.uuid)
  };
  const incidents = [];
  const text = extractMessageText(record);
  incidents.push(...extractEditStringNotFoundIncidents(record, base, toolUses));
  if (/\[Tool use interrupted\]/i.test(text)) {
    incidents.push({
      ...base,
      type: 'tool_use_interrupted_text',
      text: truncateText(text, 800)
    });
  }
  if (
    !containsClaudeEditStringNotFound(text)
    && (/InputValidationError/i.test(text) || /required parameter/i.test(text) || /tool_use_error/i.test(text))
  ) {
    const validation = parseClaudeToolValidationText(text);
    incidents.push({
      ...base,
      type: 'tool_input_validation_error',
      ...(validation || {}),
      text: truncateText(text, 1200)
    });
  }

  readRecordMessageContent(record).forEach((part) => {
    if (!part || typeof part !== 'object' || part.type !== 'tool_use') return;
    const toolName = normalizeString(part.name);
    const input = part.input && typeof part.input === 'object' && !Array.isArray(part.input)
      ? part.input
      : {};
    const inputKeys = Object.keys(input);
    const required = toolRequirements instanceof Map && Array.isArray(toolRequirements.get(toolName))
      ? toolRequirements.get(toolName)
      : null;
    if (!required) return;
    const missingRequired = required.filter((key) => !Object.prototype.hasOwnProperty.call(input, key));
    if (inputKeys.length > 0 && missingRequired.length === 0) return;
    if (missingRequired.length === 0) return;
    incidents.push({
      ...base,
      type: 'tool_use_missing_input',
      toolName,
      toolUseId: normalizeString(part.id),
      inputKeys,
      knownRequiredKeys: required,
      requiredSource: 'tool_schema',
      missingRequired
    });
  });

  const attachment = record.attachment && typeof record.attachment === 'object' ? record.attachment : null;
  if (attachment && attachment.type === 'goal_status' && attachment.met === false) {
    incidents.push({
      ...base,
      type: 'goal_status_unmet',
      condition: truncateText(attachment.condition, 800),
      reason: truncateText(attachment.reason, 1200)
    });
  }
  return incidents;
}

function extractClaudeStopHookError(record, filePath, pathImpl) {
  const attachment = record && record.attachment && typeof record.attachment === 'object'
    ? record.attachment
    : null;
  if (!attachment || attachment.type !== 'hook_non_blocking_error') return null;
  const hookName = normalizeString(attachment.hookName || attachment.hookEvent);
  if (hookName && hookName.toLowerCase() !== 'stop') return null;
  const stderr = normalizeString(attachment.stderr);
  if (!/json validation failed/i.test(stderr)) return null;

  const sessionId = normalizeString(record.sessionId) || pathImpl.basename(filePath, '.jsonl');
  return {
    type: 'hook_non_blocking_error',
    sessionId,
    projectDirName: pathImpl.basename(pathImpl.dirname(filePath)),
    transcriptPath: filePath,
    timestamp: normalizeString(record.timestamp),
    timestampMs: getRecordTimestampMs(record),
    cwd: normalizeString(record.cwd),
    hookName: hookName || 'Stop',
    hookEvent: normalizeString(attachment.hookEvent || 'Stop'),
    toolUseID: normalizeString(attachment.toolUseID),
    command: truncateText(attachment.command, DEFAULT_TEXT_LIMIT),
    stdout: truncateText(attachment.stdout, DEFAULT_TEXT_LIMIT),
    stderr: truncateText(attachment.stderr, DEFAULT_TEXT_LIMIT),
    exitCode: Number.isInteger(attachment.exitCode) ? attachment.exitCode : null,
    durationMs: Number.isFinite(Number(attachment.durationMs)) ? Number(attachment.durationMs) : null
  };
}

function extractClaudeStopHookSummary(record, filePath, pathImpl) {
  if (!record || record.type !== 'system' || record.subtype !== 'stop_hook_summary') return null;
  const errors = Array.isArray(record.hookErrors) ? record.hookErrors.map(normalizeString).filter(Boolean) : [];
  if (!errors.some((error) => /json validation failed/i.test(error))) return null;
  const hookInfos = Array.isArray(record.hookInfos) ? record.hookInfos : [];
  const sessionId = normalizeString(record.sessionId) || pathImpl.basename(filePath, '.jsonl');
  return {
    type: 'stop_hook_summary',
    sessionId,
    projectDirName: pathImpl.basename(pathImpl.dirname(filePath)),
    transcriptPath: filePath,
    timestamp: normalizeString(record.timestamp),
    timestampMs: getRecordTimestampMs(record),
    cwd: normalizeString(record.cwd),
    hookCount: Number.isInteger(record.hookCount) ? record.hookCount : null,
    hookErrors: errors,
    hookInfos: hookInfos.slice(0, 5).map((info) => ({
      command: truncateText(info && info.command, DEFAULT_TEXT_LIMIT),
      promptText: truncateText(info && info.promptText, DEFAULT_TEXT_LIMIT),
      durationMs: Number.isFinite(Number(info && info.durationMs)) ? Number(info.durationMs) : null
    })),
    preventedContinuation: typeof record.preventedContinuation === 'boolean' ? record.preventedContinuation : undefined,
    hasOutput: typeof record.hasOutput === 'boolean' ? record.hasOutput : undefined,
    level: normalizeString(record.level)
  };
}

function collectTranscriptCandidates({ fs: fsImpl, path: pathImpl, hostHomeDir, cwd, maxFiles = DEFAULT_MAX_FILES }) {
  const hostHome = normalizeString(hostHomeDir);
  const projectPath = normalizeString(cwd);
  if (!hostHome || !projectPath) return [];

  const projectDir = pathImpl.join(hostHome, '.claude', 'projects', sanitizeClaudeProjectDirName(projectPath));
  try {
    if (!fsImpl.existsSync(projectDir)) return [];
    return fsImpl.readdirSync(projectDir)
      .filter((fileName) => fileName.endsWith('.jsonl'))
      .map((fileName) => {
        const filePath = pathImpl.join(projectDir, fileName);
        let mtimeMs = 0;
        try {
          mtimeMs = Number(fsImpl.statSync(filePath).mtimeMs) || 0;
        } catch (_error) {}
        return { filePath, mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, Math.max(1, Number(maxFiles) || DEFAULT_MAX_FILES));
  } catch (_error) {
    return [];
  }
}

function collectClaudeToolProtocolDiagnostics(options = {}) {
  const fsImpl = options.fs;
  const pathImpl = options.path;
  if (!fsImpl || !pathImpl) return { found: false, incidents: [], counts: {} };

  const nowMs = Number(options.nowMs) || Date.now();
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs) || DEFAULT_MAX_AGE_MS);
  const sinceMs = Math.max(0, Number(options.sinceMs) || (nowMs - maxAgeMs));
  const candidates = collectTranscriptCandidates({
    fs: fsImpl,
    path: pathImpl,
    hostHomeDir: options.hostHomeDir,
    cwd: options.cwd,
    maxFiles: options.maxFiles
  });

  const incidents = [];
  candidates.forEach(({ filePath }) => {
    const tailText = readJsonlTail(fsImpl, filePath, options.tailBytes || DEFAULT_TAIL_BYTES);
    if (!tailText.trim()) return;
    const toolRequirements = new Map();
    const toolUses = new Map();
    const records = tailText
      .split(/\n/)
      .map((line) => safeParseJson(line.trim()))
      .filter(Boolean);
    records.forEach((record) => {
      collectToolRequirementsFromRecord(record, toolRequirements);
      collectToolUsesFromRecord(record, toolUses);
    });
    records.forEach((record) => {
      if (!record) return;
      const recordTime = getRecordTimestampMs(record);
      if (recordTime && recordTime < sinceMs) return;
      incidents.push(...extractClaudeToolProtocolIncidents(record, filePath, pathImpl, toolRequirements, toolUses));
    });
  });

  incidents.sort((left, right) => (Number(right.timestampMs) || 0) - (Number(left.timestampMs) || 0));
  const counts = {};
  incidents.forEach((incident) => {
    const key = normalizeString(incident.type) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  });
  return {
    found: incidents.length > 0,
    latest: incidents[0] || null,
    counts,
    incidents: incidents.slice(0, 20),
    scannedFiles: candidates.map((item) => item.filePath)
  };
}

function collectClaudeStopHookDiagnostics(options = {}) {
  const fsImpl = options.fs;
  const pathImpl = options.path;
  if (!fsImpl || !pathImpl) return { found: false, errors: [], summaries: [] };

  const nowMs = Number(options.nowMs) || Date.now();
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs) || DEFAULT_MAX_AGE_MS);
  const sinceMs = Math.max(0, Number(options.sinceMs) || (nowMs - maxAgeMs));
  const candidates = collectTranscriptCandidates({
    fs: fsImpl,
    path: pathImpl,
    hostHomeDir: options.hostHomeDir,
    cwd: options.cwd,
    maxFiles: options.maxFiles
  });

  const errors = [];
  const summaries = [];
  candidates.forEach(({ filePath }) => {
    const tailText = readJsonlTail(fsImpl, filePath, options.tailBytes || DEFAULT_TAIL_BYTES);
    if (!tailText.trim()) return;
    tailText.split(/\n/).forEach((line) => {
      const record = safeParseJson(line.trim());
      if (!record) return;
      const recordTime = getRecordTimestampMs(record);
      if (recordTime && recordTime < sinceMs) return;
      const error = extractClaudeStopHookError(record, filePath, pathImpl);
      if (error) {
        errors.push(error);
        return;
      }
      const summary = extractClaudeStopHookSummary(record, filePath, pathImpl);
      if (summary) summaries.push(summary);
    });
  });

  const sortByTimeDesc = (left, right) => (Number(right.timestampMs) || 0) - (Number(left.timestampMs) || 0);
  errors.sort(sortByTimeDesc);
  summaries.sort(sortByTimeDesc);
  const latest = errors[0] || summaries[0] || null;
  return {
    found: Boolean(latest),
    latest,
    errors: errors.slice(0, 5),
    summaries: summaries.slice(0, 5),
    scannedFiles: candidates.map((item) => item.filePath)
  };
}

function buildClaudeToolDiagnosticEntry(input = {}) {
  const diagnostic = input.diagnostic || {};
  return {
    ts: new Date(Number(input.nowMs) || Date.now()).toISOString(),
    kind: 'claude_tool_protocol',
    ...buildDiagnosticIdentity(input),
    cwd: normalizeString(input.cwd),
    accountId: normalizeString(input.accountId) || undefined,
    cliPath: normalizeString(input.cliPath) || undefined,
    args: Array.isArray(input.forwardArgs) ? input.forwardArgs.map((arg) => String(arg || '')) : undefined,
    triggerOutput: truncateText(input.triggerOutput, 1200),
    foundTranscriptEvidence: Boolean(diagnostic.found),
    latest: diagnostic.latest || null,
    counts: diagnostic.counts || {},
    incidents: Array.isArray(diagnostic.incidents) ? diagnostic.incidents : [],
    scannedFiles: Array.isArray(diagnostic.scannedFiles) ? diagnostic.scannedFiles : []
  };
}

function buildClaudeHookDiagnosticEntry(input = {}) {
  const diagnostic = input.diagnostic || {};
  const latest = diagnostic.latest || null;
  return {
    ts: new Date(Number(input.nowMs) || Date.now()).toISOString(),
    kind: 'claude_stop_hook_json_validation',
    ...buildDiagnosticIdentity(input),
    cwd: normalizeString(input.cwd),
    accountId: normalizeString(input.accountId) || undefined,
    cliPath: normalizeString(input.cliPath) || undefined,
    args: Array.isArray(input.forwardArgs) ? input.forwardArgs.map((arg) => String(arg || '')) : undefined,
    triggerOutput: truncateText(input.triggerOutput, 1200),
    foundTranscriptEvidence: Boolean(diagnostic.found),
    latest,
    errors: Array.isArray(diagnostic.errors) ? diagnostic.errors : [],
    summaries: Array.isArray(diagnostic.summaries) ? diagnostic.summaries : [],
    scannedFiles: Array.isArray(diagnostic.scannedFiles) ? diagnostic.scannedFiles : []
  };
}

function appendClaudeToolDiagnosticLog(options = {}) {
  const fsImpl = options.fs;
  const pathImpl = options.path;
  const aiHomeDir = normalizeString(options.aiHomeDir);
  if (!fsImpl || !pathImpl || !aiHomeDir) return { ok: false, logPath: '' };

  const logPath = pathImpl.join(aiHomeDir, 'claude-hook-diagnostics.jsonl');
  const entry = buildClaudeToolDiagnosticEntry(options);
  try {
    fsImpl.mkdirSync(pathImpl.dirname(logPath), { recursive: true });
    fsImpl.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    return { ok: true, logPath, entry };
  } catch (_error) {
    return { ok: false, logPath, entry };
  }
}

function appendClaudeHookDiagnosticLog(options = {}) {
  const fsImpl = options.fs;
  const pathImpl = options.path;
  const aiHomeDir = normalizeString(options.aiHomeDir);
  if (!fsImpl || !pathImpl || !aiHomeDir) return { ok: false, logPath: '' };

  const logPath = pathImpl.join(aiHomeDir, 'claude-hook-diagnostics.jsonl');
  const entry = buildClaudeHookDiagnosticEntry(options);
  try {
    fsImpl.mkdirSync(pathImpl.dirname(logPath), { recursive: true });
    fsImpl.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    return { ok: true, logPath, entry };
  } catch (_error) {
    return { ok: false, logPath, entry };
  }
}

module.exports = {
  appendClaudeHookDiagnosticLog,
  appendClaudeToolDiagnosticLog,
  buildClaudeHookDiagnosticEntry,
  buildClaudeToolDiagnosticEntry,
  collectClaudeStopHookDiagnostics,
  collectClaudeToolProtocolDiagnostics,
  containsClaudeToolProtocolProblem,
  containsClaudeStopHookJsonValidationError,
  sanitizeClaudeProjectDirName
};
