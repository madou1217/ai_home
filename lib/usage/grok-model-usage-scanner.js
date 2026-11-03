'use strict';

const { isAccountRef } = require('../account/public-account-ref');
const { resolvePhysicalPath } = require('./kimi-session-index');
const { stableHash } = require('./model-usage-stable-hash');

const GROK_USAGE_PROJECTION_VERSION = 2;

function readJson(fs, filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_error) { return null; }
}

function toInt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function timestampMs(value) {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  return Date.parse(String(value || '')) || 0;
}

function isGrokSessionId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(String(value || ''));
}

function discoverSessionFiles(fs, path, root, sessionId) {
  const files = [];
  try {
    for (const project of fs.readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const file = path.join(root, project.name, sessionId, 'updates.jsonl');
      try { if (fs.statSync(file).isFile()) files.push(file); } catch (_error) {}
    }
  } catch (_error) {}
  return files;
}

function discoverGrokUsageFiles({ fs, path, hostHomeDir, aiHomeDir, listFilesRecursive, sessionId = '' }) {
  if (sessionId && !isGrokSessionId(sessionId)) return [];
  const roots = [
    path.join(hostHomeDir, '.grok', 'sessions'),
    path.join(hostHomeDir, '.grok', '.aih-runtime-home', 'sessions')
  ];
  const projectionRoot = path.join(aiHomeDir, 'run', 'auth-projections', 'grok');
  if (aiHomeDir) {
    try {
      for (const accountRef of fs.readdirSync(projectionRoot)) {
        if (!isAccountRef(accountRef)) continue;
        roots.push(path.join(projectionRoot, accountRef, '.grok', 'sessions'));
        roots.push(path.join(projectionRoot, accountRef, 'sessions'));
      }
    } catch (_error) {}
  }
  const files = new Set();
  const physicalRoots = new Set(roots.map((root) => resolvePhysicalPath(fs, path, root)));
  for (const root of physicalRoots) {
    const candidates = sessionId
      ? discoverSessionFiles(fs, path, root, sessionId)
      : listFilesRecursive(fs, path, root, (_full, name) => name === 'updates.jsonl');
    for (const file of candidates) {
      files.add(resolvePhysicalPath(fs, path, file));
    }
  }
  return [...files].sort();
}

function accountRefFromProjectionPath(path, aiHomeDir, candidate) {
  if (!aiHomeDir) return '';
  const root = path.resolve(aiHomeDir, 'run', 'auth-projections', 'grok');
  const relative = path.relative(root, path.resolve(String(candidate || '')));
  const parts = relative.split(path.sep);
  return parts.length >= 2 && isAccountRef(parts[0]) && (parts[1] === '.grok' || parts[1] === 'sessions')
    ? parts[0] : '';
}

function resolveGrokUsageAccountRef(path, aiHomeDir, filePath, summary = {}) {
  // Grok 在每个会话 summary 中记录实际 GROK_HOME。它能在共享宿主 sessions
  // 软链下保留账号归属，但只接受 AIH 自己生成的 account projection 路径。
  const fromSummary = accountRefFromProjectionPath(path, aiHomeDir, summary.grok_home);
  if (fromSummary) return fromSummary;
  return accountRefFromProjectionPath(path, aiHomeDir, filePath);
}

function scanGrokUsageFile({ fs, path, store, filePath, aiHomeDir, readJsonlFromOffset }) {
  const stat = fs.statSync(filePath);
  const state = store.getFileState(filePath);
  const context = state.scanContext && typeof state.scanContext === 'object' ? state.scanContext : {};
  const sessionDir = path.dirname(filePath);
  const summary = readJson(fs, path.join(sessionDir, 'summary.json')) || {};
  const sessionId = path.basename(sessionDir);
  let cwd = String(summary.info && summary.info.cwd || '').trim();
  if (!cwd) {
    try { cwd = decodeURIComponent(path.basename(path.dirname(sessionDir))); } catch (_error) {}
  }
  const accountRef = resolveGrokUsageAccountRef(path, aiHomeDir, filePath, summary);
  const needsProjectionRebuild = Number(context.grokUsageProjectionVersion) !== GROK_USAGE_PROJECTION_VERSION
    || String(context.attributedAccountRef || '') !== accountRef
    || stat.size < state.offset;
  const startOffset = stat.size < state.offset || needsProjectionRebuild ? 0 : state.offset;
  const project = path.basename(cwd);
  const records = [];
  const prompts = [];
  const promptIds = new Set();
  let startedAtMs = timestampMs(summary.created_at);
  let updatedAtMs = timestampMs(summary.updated_at);
  const fileHash = stableHash(filePath);

  const read = readJsonlFromOffset(fs, filePath, startOffset, (line, offset) => {
    let entry;
    try { entry = JSON.parse(line); } catch (_error) { return; }
    const params = entry && entry.params;
    const update = params && params.update;
    if (!update || update.sessionUpdate !== 'turn_completed') return;
    const usage = update.usage;
    const at = timestampMs(params._meta && params._meta.agentTimestampMs || entry.timestamp);
    if (!usage || typeof usage !== 'object' || !(at > 0)) return;
    const promptId = String(update.prompt_id || '').trim();
    const eventId = promptId || String(params._meta && params._meta.eventId || '').trim() || String(offset);
    // _meta.totalTokens 是上下文长度；只消费完成事件里的逐轮、逐模型计费账单。
    const modelUsage = usage.modelUsage && typeof usage.modelUsage === 'object' ? usage.modelUsage : {};
    for (const [model, tokens] of Object.entries(modelUsage)) {
      if (!model.trim() || !tokens || typeof tokens !== 'object') continue;
      const input = toInt(tokens.inputTokens);
      const output = toInt(tokens.outputTokens);
      const cacheRead = Math.min(input, toInt(tokens.cachedReadTokens));
      const cacheCreation = Math.min(input - cacheRead, toInt(tokens.cacheCreationTokens));
      const reasoning = Math.min(output, toInt(tokens.reasoningTokens));
      if (!input && !output) continue;
      const costUsdTicks = tokens.costUsdTicks;
      const hasReportedCost = typeof costUsdTicks === 'number' && Number.isFinite(costUsdTicks)
        && costUsdTicks >= 0 && !tokens.costIsPartial && !usage.costIsPartial && !usage.usageIsIncomplete;
      records.push({
        eventKey: `grok:file:${fileHash}:${stableHash(eventId)}:${stableHash(model)}:usage`,
        provider: 'grok', sourceKind: 'session_jsonl', accountRef, sessionId, model,
        inputTokens: input - cacheRead - cacheCreation,
        outputTokens: output - reasoning,
        cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation,
        reasoningOutputTokens: reasoning, totalTokens: input + output,
        ...(hasReportedCost ? { costUsd: costUsdTicks / 1e10 } : {}),
        timestampMs: at, cwd, project
      });
    }
    if (promptId && !promptIds.has(promptId)) {
      promptIds.add(promptId);
      prompts.push({ eventKey: `grok:file:${fileHash}:${stableHash(promptId)}:prompt`,
        provider: 'grok', sessionId, timestampMs: at });
    }
    if (!startedAtMs || at < startedAtMs) startedAtMs = at;
    updatedAtMs = Math.max(updatedAtMs, at);
  });
  const sessionRecords = [{ provider: 'grok', sessionId, cwd, project, startedAtMs, updatedAtMs, promptCount: prompts.length }];
  const fileState = { size: stat.size, offset: read.hadTrailingLine ? read.trailingLineStart : read.offset,
    scanContext: { grokUsageProjectionVersion: GROK_USAGE_PROJECTION_VERSION, attributedAccountRef: accountRef } };
  if (needsProjectionRebuild) {
    const rebuilt = store.replaceFileProjection({
      provider: 'grok', sourceHash: fileHash, filePath, usageRecords: records,
      promptEvents: prompts, sessionRecords, fileState
    });
    return { records: rebuilt.records, prompts: rebuilt.prompts };
  }
  const inserted = store.insertUsageBatch(records);
  const promptsInserted = store.insertPromptEvents(prompts);
  if (records.length || prompts.length) store.upsertSessions(sessionRecords.map((record) => ({ ...record, promptCount: promptsInserted })));
  // 写入中的半行留给下一次扫描；幂等 eventKey 保护已完成行。
  store.setFileState(filePath, fileState);
  return { records: inserted, prompts: promptsInserted };
}

module.exports = { discoverGrokUsageFiles, isGrokSessionId, scanGrokUsageFile };
