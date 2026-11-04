'use strict';

const { resolvePhysicalPath } = require('./kimi-session-index');
const { stableHash } = require('./model-usage-stable-hash');
const { CODEBUDDY_CONFIG_DIR_BY_PROVIDER, CODEBUDDY_SESSION_ROOTS_BY_PROVIDER } = require('../sessions/session-reader-codebuddy');

// v2：同一物理会话可能被同族两个站点硬链接/共享（.codebuddy 与 .codebuddy-cn），
// 发现阶段按 dev+ino 去重，并顺带从消息里派生账号健康结果。版本变化会强制重建，
// 让历史重复行在 reconcile 时被清掉。
const PROJECTION_VERSION = 2;
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
  // 物理文件身份：realpath 只去符号链接，去不掉硬链接。同族两个站点的 projects
  // 可能是同一份存储（或历史归一留下硬链接），同一批消息会在两个 Provider 下
  // 各记一次；用 dev+ino 认物理文件，保证一个文件只扫一遍。
  const identities = new Map();
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
        let stat;
        try { stat = fs.statSync(filePath); if (!stat.isFile()) continue; } catch (_) { continue; }
        const physical = resolvePhysicalPath(fs, path, filePath);
        const identity = stat.ino > 0 ? `${stat.dev}:${stat.ino}` : physical;
        if (identities.has(identity)) continue;
        identities.set(identity, physical);
        files.set(physical, {
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

// 会话 JSONL 里的失败证据 → Go 的 FailureKind 闭集（见 lib/server/account-outcome-kinds.js）。
// 只描述「这一次请求」：429 是限流，空流/超时是流断开，网络错误是连接重置。
// 归类宁可保守（unclassified 会计入分母），也不把账号问题误报成请求问题。
function classifyCodebuddyOutcome(error) {
  if (!error) return 'success';
  const message = String(error.message || '').toLowerCase();
  if (error.isStreamTimeout || /timed out|timeout/.test(message)) return 'stream_disconnected';
  if (error.isNetworkError || /network|socket|econn|reset|dns|connect/.test(message)) return 'connection_reset';
  if (/429|too many requests|frequency limit|rate limit/.test(message)) return 'rate_limited';
  if (/quota|exhaust|usage limit|insufficient.*(quota|balance)|billing/.test(message)) return 'quota_exhausted';
  if (/401|403|unauthor|invalid.*(token|credential)|authentication/.test(message)) return 'credential_rejected';
  if (/permission|forbidden/.test(message)) return 'permission_denied';
  if (/5\d\d|server error|service unavailable|overloaded|bad gateway/.test(message)) return 'upstream_unavailable';
  if (/empty stream|no valid response|finish_reason=error|malformed|parse/.test(message)) return 'malformed_response';
  if (/context.*(length|window)|too many tokens/.test(message)) return 'invalid_request';
  return 'unclassified';
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
  if (!rebuild && stat.size === state.size && stat.mtimeMs === context.mtimeMs) {
    return { records: 0, prompts: 0, outcomes: 0 };
  }
  const startOffset = rebuild || stat.size === state.size ? 0 : state.offset;
  const region = file.provider.endsWith('cn') ? 'cn' : 'global';
  const prefix = `codebuddy:message:${stableHash(`${region}:${sessionId}`)}:`;
  // 健康结果按会话+消息去重，不带 region：同一物理会话可能被两个站点各扫一次，
  // 用量行由 store 按 message hash 收敛，结果行则靠这个跨站点唯一的键幂等。
  const outcomePrefix = `codebuddy:outcome:${stableHash(sessionId)}:`;
  const previous = new Map(store.db.prepare(`
    SELECT event_key, provider, account_ref FROM model_usage_records WHERE event_key GLOB ?
  `).all(`${prefix}*:usage`).map((row) => [row.event_key, row]));
  const records = [];
  const prompts = [];
  const outcomes = [];
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
    // 健康结果：失败消息通常没有 usage（错误在 providerData.error），不能和用量
    // 用同一个门槛；成功只认带 usage 的 assistant 消息，避免把工具/占位回合算成请求。
    if (entry.type === 'message' && entry.role === 'assistant' && owner.accountRef) {
      const error = entry.providerData && entry.providerData.error;
      const outcome = error ? classifyCodebuddyOutcome(error) : (usage && model ? 'success' : '');
      if (outcome) {
        outcomes.push({
          eventKey: `${outcomePrefix}${stableHash(id)}`,
          accountRef: owner.accountRef,
          provider: owner.provider,
          sessionId,
          outcome,
          timestampMs: at
        });
      }
    }
    if (!usage || !model) return;
    records.push({ eventKey: `${prefix}${stableHash(id)}:usage`, ...owner,
      sourceKind: 'session_jsonl', sessionId, model, ...usage, timestampMs: at,
      requestId: String(entry.providerData?.conversationRequestId || '').trim(),
      cwd, project: path.basename(cwd || file.projectDirName) });
  });
  const changed = store.reconcileCodebuddyUsageBatch(records);
  if (outcomes.length && typeof store.insertNativeOutcomes === 'function') {
    store.insertNativeOutcomes(outcomes);
  }
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
  return { records: changed, prompts: promptCount, outcomes: outcomes.length };
}

module.exports = { discoverCodebuddyUsageFiles, isCodebuddySessionId, readCodebuddyUsage, scanCodebuddyUsageFile };
