'use strict';

const { resolvePhysicalPath } = require('./kimi-session-index');
const { stableHash } = require('./model-usage-stable-hash');
const { CODEBUDDY_CONFIG_DIR_BY_PROVIDER, CODEBUDDY_SESSION_ROOTS_BY_PROVIDER } = require('../sessions/session-reader-codebuddy');

const PROJECTION_VERSION = 1;
const PROVIDER_BY_DIR = new Map(Object.entries(CODEBUDDY_CONFIG_DIR_BY_PROVIDER).map(([provider, dir]) => [dir, provider]));

function isCodebuddySessionId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(String(value || ''));
}

function discoverCodebuddyUsageFiles({ fs, path, hostHomeDir, providers, sessionId = '' }) {
  if (sessionId && !isCodebuddySessionId(sessionId)) return [];
  const roots = new Map();
  const nativeHome = resolvePhysicalPath(fs, path, hostHomeDir);
  for (const provider of providers) {
    for (const dir of CODEBUDDY_SESSION_ROOTS_BY_PROVIDER[provider] || []) {
      const root = path.join(hostHomeDir, dir, 'projects');
      const physical = resolvePhysicalPath(fs, path, root);
      // Prefer the native root over a same-region alias so its adjacent identity
      // database remains authoritative even when another product links projects.
      if (!roots.has(physical) || physical === path.join(nativeHome, dir, 'projects')) {
        roots.set(physical, { root, provider: PROVIDER_BY_DIR.get(dir) });
      }
    }
  }
  const files = new Map();
  for (const { root, provider } of roots.values()) {
    let directories;
    try { directories = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const projectDir = path.join(root, directory.name);
      let names;
      try { names = sessionId ? [`${sessionId}.jsonl`] : fs.readdirSync(projectDir); } catch (_) { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl') || !isCodebuddySessionId(name.slice(0, -6))) continue;
        const filePath = path.join(projectDir, name);
        try { if (!fs.statSync(filePath).isFile()) continue; } catch (_) { continue; }
        const physical = resolvePhysicalPath(fs, path, filePath);
        if (!files.has(physical)) files.set(physical, {
          filePath: physical, provider, projectsRoot: root,
          sessionId: name.slice(0, -6), projectDirName: directory.name
        });
      }
    }
  }
  return [...files.values()];
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function readCodebuddyUsage(entry) {
  if (entry.type !== 'message' || entry.role !== 'assistant') return null;
  const data = entry.providerData || {};
  const usage = data.rawUsage;
  const normalized = data.usage || {};
  const message = entry.message || {};
  const fallback = message.usage || {};
  const input = count(usage ? usage.prompt_tokens : normalized.inputTokens ?? fallback.input_tokens);
  const output = count(usage ? usage.completion_tokens : normalized.outputTokens ?? fallback.output_tokens);
  if (!input && !output) return null;
  const cacheRead = Math.min(input, count(usage
    ? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens
    : normalized.inputTokensDetails?.[0]?.cached_tokens ?? fallback.cache_read_input_tokens));
  const cacheCreation = Math.min(input - cacheRead, count(usage?.cache_creation_input_tokens ?? fallback.cache_creation_input_tokens));
  const reasoning = Math.min(output, count(usage
    ? usage.completion_tokens_details?.reasoning_tokens ?? usage.completion_thinking_tokens
    : normalized.outputTokensDetails?.[0]?.reasoning_tokens));
  return { inputTokens: input - cacheRead - cacheCreation, outputTokens: output - reasoning,
    cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation,
    reasoningOutputTokens: reasoning, totalTokens: input + output };
}

function timestamp(value) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

function scanCodebuddyUsageFile({ fs, path, store, file, ownership, scope, readJsonlFromOffset }) {
  const { filePath, sessionId } = file;
  const stat = fs.statSync(filePath);
  const state = store.getFileState(filePath);
  const context = state.scanContext || {};
  const native = ownership.resolveNative(file);
  const identity = `${ownership.fingerprint}:${native.userId}:${native.accountRef}:${ownership.writerFingerprint(file)}`;
  const activeScope = ownership.normalizeScope(scope || context.latestScope, file.provider);
  const rebuild = context.codebuddyUsageProjectionVersion !== PROJECTION_VERSION
    || context.identity !== identity || stat.size < state.offset
    || Boolean(scope) || context.ino !== stat.ino;
  if (!rebuild && stat.size === state.size && stat.mtimeMs === context.mtimeMs) return { records: 0, prompts: 0 };
  const startOffset = rebuild || stat.size === state.size ? 0 : state.offset;
  const region = file.provider.endsWith('cn') ? 'cn' : 'global';
  const prefix = `codebuddy:message:${stableHash(`${region}:${sessionId}`)}:`;
  const previous = new Map(store.db.prepare(`
    SELECT event_key, provider, account_ref FROM model_usage_records WHERE event_key GLOB ?
  `).all(`${prefix}*:usage`).map((row) => [row.event_key, row]));
  const records = [];
  const prompts = [];
  let cwd = String(context.cwd || '').trim();
  let startedAtMs = Number(context.startedAtMs) || 0;
  let updatedAtMs = Number(context.updatedAtMs) || 0;
  const read = readJsonlFromOffset(fs, filePath, startOffset, (line) => {
    let entry;
    try { entry = JSON.parse(line); } catch (_) { return; }
    const at = timestamp(entry.timestamp);
    const id = String(entry.id || '').trim();
    if (!at || !id || (entry.sessionId && entry.sessionId !== sessionId)) return;
    if (entry.cwd) cwd = String(entry.cwd).trim();
    startedAtMs = startedAtMs ? Math.min(startedAtMs, at) : at;
    updatedAtMs = Math.max(updatedAtMs, at);
    const owner = ownership.resolve(file, at, activeScope, previous.get(`${prefix}${stableHash(id)}:usage`), id);
    if (entry.type === 'message' && entry.role === 'user') {
      prompts.push({ eventKey: `${prefix}${stableHash(id)}:prompt`,
        provider: owner.provider, sessionId, timestampMs: at });
    }
    const usage = readCodebuddyUsage(entry);
    const model = String(entry.providerData?.model || entry.message?.model || '').trim();
    if (!usage || !model) return;
    records.push({ eventKey: `${prefix}${stableHash(id)}:usage`, ...owner,
      sourceKind: 'session_jsonl', sessionId, model, ...usage, timestampMs: at,
      requestId: String(entry.providerData?.conversationRequestId || '').trim(),
      cwd, project: path.basename(cwd || file.projectDirName) });
  });
  const changed = store.reconcileCodebuddyUsageBatch(records);
  const providers = new Set(records.map((record) => record.provider));
  for (const prompt of prompts) providers.add(prompt.provider);
  providers.add(file.provider);
  let promptCount = 0;
  const sessions = [...providers].map((provider) => {
    const inserted = store.insertPromptEvents(prompts.filter((prompt) => prompt.provider === provider));
    promptCount += inserted;
    return { provider, sessionId, cwd, project: path.basename(cwd || file.projectDirName),
      startedAtMs, updatedAtMs, promptCount: inserted };
  });
  store.upsertSessions(sessions);
  store.setFileState(filePath, { size: stat.size,
    offset: read.hadTrailingLine ? read.trailingLineStart : read.offset,
    scanContext: { codebuddyUsageProjectionVersion: PROJECTION_VERSION, identity,
      ino: stat.ino, mtimeMs: stat.mtimeMs, cwd, startedAtMs, updatedAtMs, latestScope: activeScope } });
  return { records: changed, prompts: promptCount };
}

module.exports = { discoverCodebuddyUsageFiles, isCodebuddySessionId, readCodebuddyUsage, scanCodebuddyUsageFile };
