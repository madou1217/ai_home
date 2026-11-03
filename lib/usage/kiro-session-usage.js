'use strict';

// kiro-cli 原生会话 → token 用量记录 + 每轮结果（`aih kiro <id>` 不经网关，这是唯一证据源）。
//
// 会话布局（2026-10-19 实测 kiro-cli 2.32，宿主共享、不按账号隔离）：
//   ~/.kiro/sessions/<sha256(cwd)[:16]>/sess_<uuid>/session.json     { modelId, workspacePaths, createdAt }
//   ~/.kiro/sessions/<sha256(cwd)[:16]>/sess_<uuid>/messages.jsonl   追加写，每行 { id, timestamp, payload }
// 关键记录：
//   * payload.type='assistant' {content}、'tool_call' {args, modelToolUseId}  —— 模型产出；
//   * payload.type='session_metadata', key='contextUsage', value.usagePercentage —— **每次模型请求一条**，
//     是本次请求的上下文占用（相对模型 maxInputTokens）；
//   * payload.type='usage_summary' {status, promptTurnSummaries:[{unit:'credit', usage}]} —— 每轮一条。
// 没有 token 字段，因此：
//   上下文 token   = usagePercentage% × 模型 maxInputTokens（未知模型记 0，不猜窗口）
//   cacheRead      = min(上一次请求的上下文, 本次上下文)——agent 循环每次重发同一前缀，按 prompt
//                    cache 语义计为缓存读；距上一次请求超过缓存 TTL（5 分钟）则视为冷启动、全部计输入
//   inputTokens    = 上下文 token − cacheRead
//   outputTokens   = 自上一次请求以来模型产出文本按字符估算
// sourceKind 带 estimated，避免被当成上游实测值。子代理（sub-executions）没有 contextUsage，
// 其 token 不在此统计里（credits 由父会话 usage_summary 覆盖）。

const { createRegistryScopeOwnership } = require('./registry-scope-ownership');

const KIRO_SESSION_USAGE_SOURCE_KIND = 'native_kiro_session_estimated';

// ListAvailableModels 的 tokenLimits.maxInputTokens 快照（2026-10-19，Kiro Pro+ 账号实测）。
// 只用于把「上下文占用百分比」换算成 token；表里没有的模型输入 token 记 0，不按相近模型猜。
const KIRO_MODEL_MAX_INPUT_TOKENS = Object.freeze({
  auto: 1000000,
  'claude-opus-5.5': 1000000,
  'claude-sonnet-5.5': 1000000,
  'claude-opus-5': 1000000,
  'claude-sonnet-5': 1000000,
  'claude-opus-4.8': 1000000,
  'claude-opus-4.7': 1000000,
  'claude-opus-4.6': 1000000,
  'claude-sonnet-4.6': 1000000,
  'claude-opus-4.5': 200000,
  'claude-sonnet-4.5': 200000,
  'claude-haiku-4.5': 200000,
  'gpt-5.6-sol': 922000,
  'gpt-5.6-terra': 922000,
  'gpt-5.6-luna': 922000,
  'deepseek-3.2': 164000,
  'minimax-m2.5': 196000,
  'minimax-m2.1': 196000,
  'glm-5': 200000,
  'qwen3-coder-next': 256000,
  'kimi-k3': 1000000
});

// Anthropic prompt cache 的默认 TTL；超过它的两次请求之间不认为前缀仍在缓存里。
const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

const SUCCESS_STATUSES = new Set(['success', 'succeeded', 'completed', 'complete', 'ok', 'done']);
const FAILURE_STATUSES = new Set(['error', 'errored', 'failed', 'failure']);

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function toTimestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// CJK 按 1 字 ≈ 1 token，其余 ~4 字符 ≈ 1 token（与 kiro 网关通道的估算同一口径）。
function estimateTokensFromChars(text) {
  const value = String(text || '');
  let cjk = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) cjk += 1;
  }
  return cjk + Math.ceil((value.length - cjk) / 4);
}

function resolveMaxInputTokens(model) {
  return KIRO_MODEL_MAX_INPUT_TOKENS[normalizeText(model).toLowerCase()] || 0;
}

/** 每轮结果：'success' / 'unclassified'（失败闭集里的「其他」）/ ''（取消等，不记）。 */
function classifyKiroTurnStatus(status) {
  const value = normalizeText(status).toLowerCase();
  if (SUCCESS_STATUSES.has(value)) return 'success';
  if (FAILURE_STATUSES.has(value)) return 'unclassified';
  return '';
}

function sumCredits(summary) {
  const turns = Array.isArray(summary && summary.promptTurnSummaries) ? summary.promptTurnSummaries : [];
  return turns.reduce((total, turn) => {
    const usage = Number(turn && turn.usage);
    return normalizeText(turn && turn.unit).toLowerCase() === 'credit' && Number.isFinite(usage) ? total + usage : total;
  }, 0);
}

/**
 * 增量解析器：逐行喂入 messages.jsonl，产出用量与每轮结果。
 * pendingOutputTokens 跨增量扫描保留（一次请求的产出可能被两次扫描劈开）。
 */
function createKiroSessionLineParser(context = {}) {
  const model = normalizeText(context.model);
  const maxInputTokens = resolveMaxInputTokens(model);
  let pendingOutput = Math.max(0, Number(context.pendingOutputTokens) || 0);
  let lastContextTokens = Math.max(0, Number(context.lastContextTokens) || 0);
  let lastContextAtMs = Math.max(0, Number(context.lastContextAtMs) || 0);

  return {
    parse(line, lineOffset) {
      let entry = null;
      try {
        entry = JSON.parse(line);
      } catch (_error) {
        return null;
      }
      const payload = entry && entry.payload;
      if (!payload || typeof payload !== 'object') return null;
      const timestampMs = toTimestampMs(entry.timestamp);
      const id = normalizeText(entry.id) || `offset:${lineOffset}`;
      if (payload.type === 'assistant' && typeof payload.content === 'string') {
        pendingOutput += estimateTokensFromChars(payload.content);
        return null;
      }
      if (payload.type === 'tool_call' && normalizeText(payload.modelToolUseId) && payload.args) {
        pendingOutput += estimateTokensFromChars(JSON.stringify(payload.args));
        return null;
      }
      if (payload.type === 'session_metadata' && payload.key === 'contextUsage') {
        const percentage = Number(payload.value && payload.value.usagePercentage);
        if (!Number.isFinite(percentage) || percentage < 0 || !timestampMs) return null;
        const contextTokens = maxInputTokens ? Math.round((percentage / 100) * maxInputTokens) : 0;
        const warm = lastContextAtMs > 0 && timestampMs - lastContextAtMs <= PROMPT_CACHE_TTL_MS;
        const cacheReadInputTokens = warm ? Math.min(lastContextTokens, contextTokens) : 0;
        const outputTokens = pendingOutput;
        pendingOutput = 0;
        lastContextTokens = contextTokens;
        lastContextAtMs = timestampMs;
        if (!contextTokens && !outputTokens) return null;
        return {
          kind: 'usage',
          eventKey: `kiro:context:${id}`,
          executionId: normalizeText(payload.executionId),
          model,
          inputTokens: contextTokens - cacheReadInputTokens,
          cacheReadInputTokens,
          outputTokens,
          timestampMs
        };
      }
      if (payload.type === 'usage_summary') {
        return {
          kind: 'turn',
          eventKey: `kiro:turn:${id}`,
          executionId: normalizeText(payload.executionId),
          status: normalizeText(payload.status),
          outcome: classifyKiroTurnStatus(payload.status),
          credits: sumCredits(payload),
          timestampMs
        };
      }
      return null;
    },
    get pendingOutputTokens() {
      return pendingOutput;
    },
    /** 跨增量扫描需要持久化的全部状态。 */
    snapshot() {
      return { pendingOutputTokens: pendingOutput, lastContextTokens, lastContextAtMs };
    }
  };
}

function safeReadJson(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

/** session.json → { sessionId, model, cwd, startedAtMs }。 */
function readKiroSessionMeta(fs, path, messagesPath) {
  const sessionDir = path.dirname(messagesPath);
  const meta = safeReadJson(fs, path.join(sessionDir, 'session.json')) || {};
  const workspaces = Array.isArray(meta.workspacePaths) ? meta.workspacePaths : [];
  return {
    sessionId: normalizeText(meta.id) || path.basename(sessionDir),
    model: normalizeText(meta.modelId),
    cwd: normalizeText(workspaces[0]),
    startedAtMs: toTimestampMs(meta.createdAt)
  };
}

/** ~/.kiro/sessions/<hash>/sess_* /messages.jsonl（只认这一层，不递归进 sub-executions）。 */
function discoverKiroSessionFiles({ fs, path, hostHomeDir }) {
  const root = path.join(normalizeText(hostHomeDir), '.kiro', 'sessions');
  const files = [];
  let groups = [];
  try {
    groups = fs.readdirSync(root, { withFileTypes: true });
  } catch (_error) {
    return files;
  }
  for (const group of groups) {
    if (!group.isDirectory() || !/^[0-9a-f]{16}$/.test(group.name)) continue;
    let sessions = [];
    try {
      sessions = fs.readdirSync(path.join(root, group.name), { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory() || !session.name.startsWith('sess_')) continue;
      const messagesPath = path.join(root, group.name, session.name, 'messages.jsonl');
      if (fs.existsSync(messagesPath)) files.push(messagesPath);
    }
  }
  return files;
}

function createKiroUsageOwnership(options = {}) {
  return createRegistryScopeOwnership({ ...options, provider: 'kiro' });
}

function inferProject(path, cwd, fallback) {
  return cwd ? path.basename(cwd) : fallback;
}

/**
 * 扫描一个会话文件（增量：按字节偏移续读，事件键去重）。
 * 归属在扫描时按事件时间点判定；判不出（无作用域 / 多账号同目录）就记为未归属，不猜。
 * 由 model-usage-scanner 的 kiro 分支调用，store 契约与其它 provider 相同。
 */
function scanKiroSessionFile({ fs, path, store, filePath, readJsonlFromOffset, resolveOwnership }) {
  const stat = fs.statSync(filePath);
  const state = store.getFileState(filePath);
  const startOffset = state && Number(state.offset) <= stat.size ? Number(state.offset) || 0 : 0;
  if (startOffset >= stat.size) return { records: 0, prompts: 0 };
  const meta = readKiroSessionMeta(fs, path, filePath);
  const previous = (state && state.scanContext) || {};
  const parser = createKiroSessionLineParser({
    model: meta.model,
    ...(startOffset > 0 ? previous : {})
  });
  const records = [];
  // 尾行可能还没写完：下次会从它的起点重读，因此它之前的解析状态才是要持久化的状态。
  let stateBeforeLastLine = parser.snapshot();
  const read = readJsonlFromOffset(fs, filePath, startOffset, (line, lineOffset) => {
    stateBeforeLastLine = parser.snapshot();
    const event = parser.parse(line, lineOffset);
    if (!event || event.kind !== 'usage') return;
    const ownership = typeof resolveOwnership === 'function'
      ? resolveOwnership({ sessionId: meta.sessionId, cwd: meta.cwd, atMs: event.timestampMs })
      : { accountRef: '' };
    const accountRef = normalizeText(ownership && ownership.accountRef);
    records.push({
      eventKey: event.eventKey,
      provider: 'kiro',
      sourceKind: KIRO_SESSION_USAGE_SOURCE_KIND,
      sessionId: meta.sessionId,
      model: event.model || 'kiro',
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadInputTokens: event.cacheReadInputTokens,
      cacheCreationInputTokens: 0,
      totalTokens: event.inputTokens + event.cacheReadInputTokens + event.outputTokens,
      timestampMs: event.timestampMs,
      project: inferProject(path, meta.cwd, meta.sessionId),
      cwd: meta.cwd,
      ...(accountRef ? { accountRef } : {})
    });
  });
  const inserted = records.length ? store.insertUsageBatch(records) : 0;
  if (meta.sessionId) {
    store.upsertSessions([{
      provider: 'kiro',
      sessionId: meta.sessionId,
      project: inferProject(path, meta.cwd, meta.sessionId),
      cwd: meta.cwd,
      gitBranch: '',
      startedAtMs: meta.startedAtMs,
      updatedAtMs: records.length ? records[records.length - 1].timestampMs : meta.startedAtMs,
      promptCount: 0
    }]);
  }
  store.setFileState(filePath, {
    size: stat.size,
    offset: read.hadTrailingLine ? read.trailingLineStart : read.offset,
    scanContext: {
      sessionId: meta.sessionId,
      ...(read.hadTrailingLine ? stateBeforeLastLine : parser.snapshot())
    }
  });
  return { records: inserted, prompts: 0 };
}

module.exports = {
  KIRO_MODEL_MAX_INPUT_TOKENS,
  KIRO_SESSION_USAGE_SOURCE_KIND,
  classifyKiroTurnStatus,
  createKiroSessionLineParser,
  createKiroUsageOwnership,
  discoverKiroSessionFiles,
  readKiroSessionMeta,
  resolveMaxInputTokens,
  scanKiroSessionFile
};
