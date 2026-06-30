'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveNativeCliPath } = require('../runtime/native-cli-resolver');
const { loadNodePty } = require('../runtime/node-pty-loader');
const { buildPtyLaunch, resolveWindowsBatchLaunch } = require('../runtime/pty-launch');
const { buildProviderRuntimeEnv } = require('../cli/services/ai-cli/provider-runtime-env');
const { createInteractivePromptDetector } = require('./native-interactive-prompts');
const { ACCOUNT_RUNTIME_CHANGED } = require('./account-runtime-event-types');
const {
  readSessionMessages,
  resolveSessionFilePath,
  getRealHome
} = require('../sessions/session-reader');
const {
  buildAuthInvalidRuntimeState
} = require('../account/runtime-state-builders');
const { detectIdentityKind } = require('../account/account-identity');
const { isApiCredentialAuthMode } = require('../account/runtime-auth-mode');
const agyWarmPool = require('./agy-warm-ls-pool');

const DEFAULT_LOCAL_CLAUDE_PACKAGE_PATH = path.join(os.homedir(), 'Downloads', 'package', 'cli.js');
const DEFAULT_NATIVE_STREAM_COLS = 220;
const DEFAULT_NATIVE_STREAM_ROWS = 32;
const PTY_SUBMIT_DELAY_MS = 160;
const OFFICIAL_NATIVE_SESSION_PROVIDERS = new Set(['codex', 'claude', 'gemini', 'agy', 'opencode']);
const IGNORED_NATIVE_STREAM_EVENT = Object.freeze({ type: 'ignored' });
const OPENCODE_NON_TERMINAL_STEP_REASONS = new Set(['tool-calls', 'tool_calls']);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isOfficialNativeSessionProvider(provider) {
  return OFFICIAL_NATIVE_SESSION_PROVIDERS.has(normalizeString(provider).toLowerCase());
}

function buildPtyInputChunks(input, options = {}) {
  const rawInput = String(input || '');
  const appendNewline = options.appendNewline !== false;
  let payload = rawInput.replace(/\r?\n/g, '\r');
  if (!appendNewline) return payload ? [payload] : [];
  if (!payload.endsWith('\r')) return payload ? [payload, '\r'] : ['\r'];
  payload = payload.slice(0, -1);
  return payload ? [payload, '\r'] : ['\r'];
}

function writePtyInput(child, input, options = {}) {
  const chunks = buildPtyInputChunks(input, options);
  if (chunks.length > 1 && chunks[chunks.length - 1] === '\r') {
    chunks.slice(0, -1).forEach((chunk) => child.write(chunk));
    const timer = setTimeout(() => {
      try {
        child.write('\r');
      } catch (_error) {}
    }, PTY_SUBMIT_DELAY_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return;
  }
  chunks.forEach((chunk) => child.write(chunk));
}

function stripAnsi(text) {
  return String(text || '').replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

function sanitizeTerminalText(text) {
  return stripAnsi(String(text || ''))
    .replace(/\u0000/g, '')
    .replace(/[^\S\r\n\t]+$/gm, '');
}

function classifyNativeSessionFailure(provider, errorLike) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const text = normalizeString(
    (errorLike && errorLike.message)
    || errorLike
    || ''
  );
  const lowered = text.toLowerCase();

  if (
    normalizedProvider === 'gemini'
    && (
      lowered.includes('permission_denied')
      || lowered.includes('the caller does not have permission')
      || lowered.includes('reason": "forbidden"')
      || lowered.includes('"status": "permission_denied"')
    )
  ) {
    return {
      code: 'gemini_permission_denied',
      message: '当前 Gemini 账号无权限（PERMISSION_DENIED）',
      retryAnotherAccount: true
    };
  }

  return {
    code: 'native_session_failed',
    message: text || 'native_session_failed',
    retryAnotherAccount: false
  };
}

function classifyNativeAccountRuntimeBlocker(provider, outputLike) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const plain = sanitizeTerminalText(String(outputLike || '')).replace(/\s+/g, ' ').trim();
  if (!plain) return null;
  const lowered = plain.toLowerCase();
  const looksUnauthorized = lowered.includes('401')
    && (
      lowered.includes('unauthorized')
      || lowered.includes('incorrect api key')
      || lowered.includes('invalid api key')
      || lowered.includes('auth')
      || lowered.includes('token')
    );
  const looksApiKeyInvalid = lowered.includes('incorrect api key')
    || lowered.includes('invalid api key')
    || lowered.includes('invalid_api_key')
    || lowered.includes('api key provided');
  const looksRefreshInvalid = lowered.includes('token_expired')
    || lowered.includes('auth_invalid_reauth_required')
    || lowered.includes('provided authentication token is expired')
    || lowered.includes('access token could not be refreshed')
    || lowered.includes('refresh token') && (
      lowered.includes('expired')
      || lowered.includes('invalid')
      || lowered.includes('reused')
    );
  const looksClaudeLoginMissing = normalizedProvider === 'claude'
    && (
      lowered.includes('authentication_failed')
      || lowered.includes('not logged in') && lowered.includes('/login')
      || lowered.includes('please run /login')
    );
  const looksAgyLoginMissing = normalizedProvider === 'agy'
    && (
      lowered.includes('not signed in')
      || lowered.includes('select login method') && lowered.includes('google oauth')
    );

  if (looksApiKeyInvalid || looksUnauthorized || looksRefreshInvalid || looksClaudeLoginMissing || looksAgyLoginMissing) {
    const reason = looksApiKeyInvalid || looksUnauthorized
      ? 'upstream_401'
      : looksClaudeLoginMissing
        ? 'claude_not_logged_in'
      : looksAgyLoginMissing
        ? 'agy_not_signed_in'
      : 'auth_invalid_reauth_required';
    return {
      provider: normalizedProvider,
      status: 'auth_invalid',
      reason,
      source: 'native_session_terminal_output',
      runtimeState: buildAuthInvalidRuntimeState(reason),
      message: plain.slice(0, 512)
    };
  }

  return null;
}

function recordNativeAccountRuntimeBlocker(options = {}, blocker = null) {
  const provider = normalizeString(options.provider || blocker && blocker.provider).toLowerCase();
  const accountId = normalizeString(options.accountId);
  if (!provider || !accountId || !blocker || !blocker.runtimeState) return false;
  let authMode = normalizeString(options.authMode || options.identityKind).toLowerCase();
  const profileDir = normalizeString(options.profileDir);
  if (!authMode && profileDir) {
    try {
      authMode = detectIdentityKind({ fs, path, provider, profileDir });
    } catch (_error) {
      authMode = '';
    }
  }
  const baseState = {
    configured: true
  };
  if (authMode) {
    baseState.authMode = authMode;
    baseState.apiKeyMode = isApiCredentialAuthMode(authMode);
  }
  const event = {
    provider,
    accountId,
    previousStatus: 'unknown',
    nextStatus: blocker.status || 'auth_invalid',
    reason: blocker.reason || 'auth_invalid_reauth_required',
    source: blocker.source || 'native_session_terminal_output',
    runtimeState: blocker.runtimeState,
    baseState
  };
  const hub = options.accountRuntimeEventHub || options.hub;
  let hubPersisted = false;
  if (hub && typeof hub.emit === 'function') {
    const results = hub.emit(ACCOUNT_RUNTIME_CHANGED, event);
    hubPersisted = results === true || (Array.isArray(results) && results[0] === true);
  }
  const service = options.accountStateService;
  if (service && typeof service.recordRuntimeFailure === 'function') {
    return service.recordRuntimeFailure(provider, accountId, blocker.runtimeState, event.baseState);
  }
  return hubPersisted;
}

function shouldScanNativeRuntimeBlockerOutput(context = {}) {
  if (context.interactiveCli === true) return true;
  if (context.explicitError === true) return true;
  const exitCode = Number(context.exitCode);
  return Number.isFinite(exitCode) && exitCode !== 0;
}

function getSessionFileMtime(sessionPath) {
  if (!sessionPath || !fs.existsSync(sessionPath)) return 0;
  try {
    return Number(fs.statSync(sessionPath).mtimeMs) || 0;
  } catch (_error) {
    return 0;
  }
}

function normalizeSearchText(value) {
  return normalizeString(value).replace(/\s+/g, ' ').toLowerCase();
}

function readFilePreview(filePath, limit = 65536) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(limit);
    const bytesRead = fs.readSync(fd, buffer, 0, limit, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch (_error) {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_error) {}
    }
  }
}

function listClaudeProjectSessionFiles(projectDirName, hostHome = getRealHome()) {
  const normalizedProjectDirName = normalizeString(projectDirName);
  if (!normalizedProjectDirName) return [];
  const projectDir = path.join(hostHome, '.claude', 'projects', normalizedProjectDirName);
  if (!fs.existsSync(projectDir)) return [];

  try {
    return fs.readdirSync(projectDir)
      .filter((fileName) => fileName.endsWith('.jsonl'))
      .map((fileName) => {
        const filePath = path.join(projectDir, fileName);
        let mtimeMs = 0;
        try {
          mtimeMs = Number(fs.statSync(filePath).mtimeMs) || 0;
        } catch (_error) {}
        return {
          id: fileName.replace(/\.jsonl$/i, ''),
          filePath,
          mtimeMs
        };
      })
      .filter((item) => item.id)
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch (_error) {
    return [];
  }
}

function walkFiles(rootDir, acceptFile) {
  const files = [];
  if (!rootDir || !fs.existsSync(rootDir)) return files;
  const visit = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    entries.forEach((entry) => {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        return;
      }
      if (entry.isFile() && acceptFile(entry.name, filePath)) {
        let mtimeMs = 0;
        try {
          mtimeMs = Number(fs.statSync(filePath).mtimeMs) || 0;
        } catch (_error) {}
        files.push({ filePath, mtimeMs });
      }
    });
  };
  visit(rootDir);
  return files;
}

function listCodexSessionFiles(hostHome = getRealHome()) {
  const sessionsDir = path.join(hostHome, '.codex', 'sessions');
  return walkFiles(
    sessionsDir,
    (fileName) => fileName.startsWith('rollout-') && fileName.endsWith('.jsonl')
  ).map((item) => {
    const uuidMatch = path.basename(item.filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    return {
      id: uuidMatch ? uuidMatch[1] : '',
      filePath: item.filePath,
      mtimeMs: item.mtimeMs
    };
  }).filter((item) => item.id);
}

function listCodexStateDbFiles(codexDir) {
  try {
    return fs.readdirSync(codexDir)
      .filter((name) => /^state_\d+\.sqlite$/i.test(name))
      .map((name) => ({ version: Number((name.match(/^state_(\d+)\.sqlite$/i) || [])[1]) || 0, filePath: path.join(codexDir, name) }))
      .sort((left, right) => right.version - left.version)
      .map((item) => item.filePath);
  } catch (_error) {
    return [];
  }
}

// codex 不能预生成 sessionId（CLI 启动不收 --session-id），新会话靠 done 时推断采纳。
// 文件扫描推断有时序坑（rollout 落盘延迟/多候选）→ 推断空 → 前端采纳不到 → 「没保持会话」+
// 后端按空 sessionId 跳过快照刷新 → 「刷新列表不可见」。改用 state DB 按 cwd 查最新 thread：
// 确定、即时、已对真实 state_5.sqlite 验证（cwd→最新会话精确命中）。文件扫描作兜底。
function inferCodexSessionIdFromStateDb(options = {}) {
  const cwd = normalizeString(options.cwd);
  if (!cwd) return '';
  const hostHome = normalizeString(options.hostHome) || getRealHome();
  const codexDir = path.join(hostHome, '.codex');
  const beforeSessionIds = new Set(
    (Array.isArray(options.beforeSessionIds) ? options.beforeSessionIds : [])
      .map((item) => normalizeString(item))
      .filter(Boolean)
  );
  const startedAtMs = Number(options.startedAt) || 0;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    return '';
  }
  if (!DatabaseSync) return '';

  for (const dbPath of listCodexStateDbFiles(codexDir)) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec('PRAGMA query_only = ON;');
      const columns = new Set(
        db.prepare('PRAGMA table_info(threads)').all().map((row) => String(row && row.name || ''))
      );
      if (!columns.has('id') || !columns.has('cwd')) continue;
      const updatedExpr = columns.has('updated_at_ms') && columns.has('updated_at')
        ? 'COALESCE(updated_at_ms, updated_at * 1000)'
        : columns.has('updated_at_ms')
          ? 'updated_at_ms'
          : columns.has('updated_at')
            ? 'updated_at * 1000'
            : '0';
      const archivedClause = columns.has('archived') ? 'AND COALESCE(archived, 0) = 0' : '';
      const rows = db.prepare(
        `SELECT id, ${updatedExpr} AS u FROM threads WHERE cwd = ? ${archivedClause} ORDER BY u DESC LIMIT 20`
      ).all(cwd);
      for (const row of rows) {
        const id = normalizeString(row && row.id);
        if (!id || beforeSessionIds.has(id)) continue;
        // 排除本轮开始之前就更新过的旧会话（留 5s 余量容忍时钟/写入抖动）。
        if (startedAtMs && Number(row.u) > 0 && Number(row.u) < (startedAtMs - 5000)) continue;
        return id;
      }
    } catch (_error) {
      // 试下一个 state db
    } finally {
      if (db && typeof db.close === 'function') {
        try { db.close(); } catch (_closeError) {}
      }
    }
  }
  return '';
}

async function inferClaudeCreatedSessionId(projectDirName, options = {}) {
  const normalizedProjectDirName = normalizeString(projectDirName);
  if (!normalizedProjectDirName) return '';

  const beforeSessionIds = new Set(
    (Array.isArray(options.beforeSessionIds) ? options.beforeSessionIds : [])
      .map((item) => normalizeString(item))
      .filter(Boolean)
  );
  const startedAt = Number(options.startedAt) || Date.now();
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 4000);
  const promptNeedle = normalizeSearchText(options.prompt).slice(0, 200);
  const hostHome = normalizeString(options.hostHome) || getRealHome();
  const deadline = Date.now() + timeoutMs;

  const matchByPrompt = (items) => {
    if (!promptNeedle) return null;
    return items.find((item) => normalizeSearchText(readFilePreview(item.filePath)).includes(promptNeedle)) || null;
  };

  while (true) {
    const allCandidates = listClaudeProjectSessionFiles(normalizedProjectDirName, hostHome);
    const freshCandidates = allCandidates.filter((item) => item.mtimeMs >= (startedAt - 1500));
    const newCandidates = freshCandidates.filter((item) => !beforeSessionIds.has(item.id));

    if (newCandidates.length === 1) return newCandidates[0].id;

    const promptMatchedNewCandidate = matchByPrompt(newCandidates);
    if (promptMatchedNewCandidate) return promptMatchedNewCandidate.id;

    const promptMatchedFreshCandidate = matchByPrompt(freshCandidates);
    if (promptMatchedFreshCandidate) return promptMatchedFreshCandidate.id;

    if (Date.now() >= deadline) {
      return newCandidates[0] ? newCandidates[0].id : '';
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// gemini 会话文件名只含短 id（如 session-...-b6a5754e.jsonl），完整 sessionId 在首行 meta。
function readGeminiSessionIdFromFile(filePath) {
  try {
    if (String(filePath || '').endsWith('.jsonl')) {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.alloc(64 * 1024);
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const firstLine = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/).find((line) => line.trim()) || '';
        return normalizeString(JSON.parse(firstLine).sessionId);
      } finally {
        fs.closeSync(fd);
      }
    }
    return normalizeString(JSON.parse(fs.readFileSync(filePath, 'utf8')).sessionId);
  } catch (_error) {
    return '';
  }
}

function listGeminiSessionFiles(hostHome = getRealHome()) {
  const tmpDir = path.join(hostHome, '.gemini', 'tmp');
  return walkFiles(
    tmpDir,
    (fileName) => fileName.startsWith('session-') && (fileName.endsWith('.jsonl') || fileName.endsWith('.json'))
  ).map((item) => ({
    id: readGeminiSessionIdFromFile(item.filePath),
    filePath: item.filePath,
    mtimeMs: item.mtimeMs
  })).filter((item) => item.id);
}

// agy(antigravity CLI)会话存储：每个 conversation 一个 brain/<id>/.system_generated/logs/transcript.jsonl，
// 用 transcript 文件做候选（id=brain 目录名，mtime=transcript mtime），保证推断到的会话可读。
function listAgySessionFiles(hostHome = getRealHome()) {
  const roots = [
    path.join(hostHome, '.gemini', 'antigravity-cli', 'brain'),
    path.join(hostHome, '.gemini', 'antigravity', 'brain')
  ];
  const results = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const transcript = path.join(root, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      let mtimeMs = 0;
      try {
        mtimeMs = Number(fs.statSync(transcript).mtimeMs) || 0;
      } catch (_error) {
        continue; // 没有 transcript 的空会话目录跳过
      }
      results.push({ id: entry.name, filePath: transcript, mtimeMs });
    }
  }
  return results;
}

function listProviderSessionFiles(provider, params = {}) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const hostHome = normalizeString(params.hostHome) || getRealHome();
  if (normalizedProvider === 'claude') {
    return listClaudeProjectSessionFiles(params.projectDirName, hostHome);
  }
  if (normalizedProvider === 'codex') {
    return listCodexSessionFiles(hostHome);
  }
  if (normalizedProvider === 'gemini') {
    return listGeminiSessionFiles(hostHome);
  }
  if (normalizedProvider === 'agy') {
    return listAgySessionFiles(hostHome);
  }
  return [];
}

async function inferCreatedSessionId(provider, options = {}) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  if (normalizedProvider === 'claude') {
    return inferClaudeCreatedSessionId(options.projectDirName, options);
  }

  // codex：优先用 state DB 按 cwd 查最新 thread（确定、即时），文件扫描兜底。
  if (normalizedProvider === 'codex' && normalizeString(options.cwd)) {
    const dbSessionId = inferCodexSessionIdFromStateDb({
      cwd: options.cwd,
      startedAt: options.startedAt,
      beforeSessionIds: options.beforeSessionIds,
      hostHome: options.hostHome
    });
    if (dbSessionId) return dbSessionId;
  }

  const beforeSessionIds = new Set(
    (Array.isArray(options.beforeSessionIds) ? options.beforeSessionIds : [])
      .map((item) => normalizeString(item))
      .filter(Boolean)
  );
  const startedAt = Number(options.startedAt) || Date.now();
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 8000);
  const promptNeedle = normalizeSearchText(options.prompt).slice(0, 200);
  const hostHome = normalizeString(options.hostHome) || getRealHome();
  const deadline = Date.now() + timeoutMs;
  // gemini resume 会先 fork 一份只含【导入旧历史】的会话，本轮新回复要稍后才落盘。
  // 此时必须要求候选会话【确实包含本轮 prompt】，否则会过早采纳到只有旧内容的 fork
  // （拿到上一轮的回复）。要求 prompt 命中即跳过“唯一新候选直接返回”和 deadline 兜底。
  const requirePromptMatch = options.requirePromptMatch === true && Boolean(promptNeedle);

  const matchByPrompt = (items) => {
    if (!promptNeedle) return null;
    return items.find((item) => normalizeSearchText(readFilePreview(item.filePath)).includes(promptNeedle)) || null;
  };

  while (true) {
    const allCandidates = listProviderSessionFiles(normalizedProvider, {
      hostHome,
      projectDirName: options.projectDirName
    });
    const freshCandidates = allCandidates.filter((item) => item.mtimeMs >= (startedAt - 1500));
    const newCandidates = freshCandidates.filter((item) => !beforeSessionIds.has(item.id));

    if (!requirePromptMatch && newCandidates.length === 1) return newCandidates[0].id;

    const promptMatchedNewCandidate = matchByPrompt(newCandidates);
    if (promptMatchedNewCandidate) return promptMatchedNewCandidate.id;

    const promptMatchedFreshCandidate = matchByPrompt(freshCandidates);
    if (promptMatchedFreshCandidate) return promptMatchedFreshCandidate.id;

    if (Date.now() >= deadline) {
      return (!requirePromptMatch && newCandidates[0]) ? newCandidates[0].id : '';
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function buildProviderEnv(provider, profileDir, baseEnv) {
  const normalizedProvider = String(provider || '').toLowerCase();
  const extraEnv = {};
  if (normalizedProvider === 'gemini') {
    extraEnv.GEMINI_CLI_TRUST_WORKSPACE = 'true';
  }
  return buildProviderRuntimeEnv(normalizedProvider, profileDir, baseEnv || process.env, {
    path,
    extraEnv
  });
}

function pushClaudeHeadlessStreamArgs(args) {
  args.push('--print', '--verbose', '--output-format', 'stream-json');
}

function buildResumeCommand(provider, options = {}) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const sessionId = normalizeString(options.sessionId);
  const prompt = String(options.prompt || '');
  const model = normalizeString(options.model);
  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const interactiveCli = !!options.interactiveCli;

  if (!isOfficialNativeSessionProvider(normalizedProvider)) {
    const error = new Error('native_session_resume_unsupported');
    error.code = 'native_session_resume_unsupported';
    throw error;
  }
  if (!sessionId) {
    const error = new Error('missing_session_id');
    error.code = 'missing_session_id';
    throw error;
  }
  if (!interactiveCli && !prompt.trim()) {
    const error = new Error('empty_prompt');
    error.code = 'empty_prompt';
    throw error;
  }

  if (normalizedProvider === 'gemini') {
    // gemini 的 `--resume <id>` 按 cwd→projectHash 发现会话，对 WebUI 场景不可靠
    // （实测必报 "No previous sessions found for this project"）。优先用
    // `--session-file <绝对路径>` 按文件直接加载历史，绕开发现机制；绝对路径不受
    // gemini 进程 HOME 影响。解析不到文件时回退到 `--resume <id>`。
    let resumeArgs = ['--resume', sessionId];
    try {
      const resolvedPath = resolveSessionFilePath('gemini', {
        sessionId,
        projectDirName: options.projectDirName
      });
      if (resolvedPath && fs.existsSync(resolvedPath)) {
        resumeArgs = ['--session-file', resolvedPath];
      }
    } catch (_error) { /* 回退到 --resume */ }
    if (interactiveCli) {
      const args = [...resumeArgs];
      if (prompt.trim()) args.push('--prompt-interactive', prompt);
      if (model) args.push('--model', model);
      return { commandName: 'gemini', args };
    }
    const args = [...resumeArgs, '--prompt-interactive', prompt];
    if (model) args.push('--model', model);
    return { commandName: 'gemini', args };
  }

  if (normalizedProvider === 'codex') {
    if (interactiveCli) {
      const args = ['resume'];
      if (model) args.push('-m', model);
      imagePaths.forEach((imagePath) => {
        args.push('-i', imagePath);
      });
      args.push(sessionId);
      if (prompt.trim()) args.push(prompt);
      return { commandName: 'codex', args };
    }
    const args = ['resume'];
    if (model) args.push('-m', model);
    imagePaths.forEach((imagePath) => {
      args.push('-i', imagePath);
    });
    args.push(sessionId, prompt);
    return { commandName: 'codex', args };
  }

  if (normalizedProvider === 'claude') {
    if (interactiveCli) {
      const args = [];
      if (model) args.push('--model', model);
      args.push('--resume', sessionId);
      if (prompt.trim()) args.push(prompt);
      return { commandName: 'claude', args };
    }
    const args = [];
    if (model) args.push('--model', model);
    pushClaudeHeadlessStreamArgs(args);
    args.push('--resume', sessionId, prompt);
    return { commandName: 'claude', args };
  }

  if (normalizedProvider === 'agy') {
    // antigravity CLI：`--conversation <id>` 恢复指定会话，`--prompt-interactive` 跑本轮并续会话。
    // --dangerously-skip-permissions 避免 agent 工具权限弹窗阻塞 PTY 驱动。
    const args = ['--conversation', sessionId, '--dangerously-skip-permissions'];
    if (prompt.trim()) args.push('--prompt-interactive', prompt);
    if (model) args.push('--model', model);
    return { commandName: 'agy', args };
  }

  if (normalizedProvider === 'opencode') {
    if (interactiveCli) {
      const args = [];
      if (model) args.push('--model', model);
      args.push('--session', sessionId);
      return { commandName: 'opencode', args };
    }
    const args = ['run', '--format', 'json', '--dangerously-skip-permissions', '--session', sessionId];
    if (model) args.push('--model', model);
    if (options.projectPath) args.push('--dir', normalizeString(options.projectPath));
    if (prompt.trim()) args.push(prompt);
    return { commandName: 'opencode', args };
  }

  const error = new Error('native_session_resume_unsupported');
  error.code = 'native_session_resume_unsupported';
  throw error;
}

function buildStartCommand(provider, options = {}) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const prompt = String(options.prompt || '');
  const model = normalizeString(options.model);
  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const interactiveCli = !!options.interactiveCli;

  if (!isOfficialNativeSessionProvider(normalizedProvider)) {
    const error = new Error('native_session_start_unsupported');
    error.code = 'native_session_start_unsupported';
    throw error;
  }
  if (!interactiveCli && !prompt.trim()) {
    const error = new Error('empty_prompt');
    error.code = 'empty_prompt';
    throw error;
  }

  if (normalizedProvider === 'gemini') {
    if (interactiveCli) {
      const args = [];
      if (options.sessionId) args.push('--session-id', normalizeString(options.sessionId));
      if (prompt.trim()) args.push('--prompt-interactive', prompt);
      if (model) args.push('--model', model);
      return { commandName: 'gemini', args };
    }
    const args = ['--prompt-interactive', prompt];
    if (options.sessionId) args.unshift('--session-id', normalizeString(options.sessionId));
    if (model) args.push('--model', model);
    return { commandName: 'gemini', args };
  }

  if (normalizedProvider === 'codex') {
    if (interactiveCli) {
      const args = [];
      if (model) args.push('-m', model);
      imagePaths.forEach((imagePath) => {
        args.push('-i', imagePath);
      });
      if (prompt.trim()) args.push(prompt);
      return { commandName: 'codex', args };
    }
    const args = [];
    if (model) args.push('-m', model);
    imagePaths.forEach((imagePath) => {
      args.push('-i', imagePath);
    });
    args.push(prompt);
    return { commandName: 'codex', args };
  }

  if (normalizedProvider === 'claude') {
    if (interactiveCli) {
      const args = [];
      if (model) args.push('--model', model);
      if (options.sessionId) args.push('--session-id', normalizeString(options.sessionId));
      if (prompt.trim()) args.push(prompt);
      return { commandName: 'claude', args };
    }
    const args = [];
    if (model) args.push('--model', model);
    pushClaudeHeadlessStreamArgs(args);
    if (options.sessionId) args.push('--session-id', normalizeString(options.sessionId));
    args.push(prompt);
    return { commandName: 'claude', args };
  }

  if (normalizedProvider === 'agy') {
    // antigravity CLI 不接受预先指定 conversation id（自动生成），新会话用 --prompt-interactive
    // 跑本轮并续会话；完成后据 brain/<id> 推断新生成的 conversation id。
    const args = ['--prompt-interactive', prompt, '--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
    return { commandName: 'agy', args };
  }

  if (normalizedProvider === 'opencode') {
    if (interactiveCli) {
      const args = [];
      if (model) args.push('--model', model);
      if (prompt.trim()) args.push('--prompt', prompt);
      return { commandName: 'opencode', args };
    }
    const args = ['run', '--format', 'json', '--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
    if (options.projectPath) args.push('--dir', normalizeString(options.projectPath));
    args.push(prompt);
    return { commandName: 'opencode', args };
  }

  const error = new Error('native_session_start_unsupported');
  error.code = 'native_session_start_unsupported';
  throw error;
}

function resolveNativeCliLaunch(provider, options = {}) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const env = options.env || process.env;
  if (normalizedProvider === 'claude') {
    const configuredScript = normalizeString(
      options.claudeCliJsPath
      || env.AIH_CLAUDE_CLI_JS_PATH
      || process.env.AIH_CLAUDE_CLI_JS_PATH
    );
    const scriptPath = configuredScript || (fs.existsSync(DEFAULT_LOCAL_CLAUDE_PACKAGE_PATH) ? DEFAULT_LOCAL_CLAUDE_PACKAGE_PATH : '');
    if (scriptPath && fs.existsSync(scriptPath)) {
      return {
        command: process.execPath,
        prefixArgs: [scriptPath]
      };
    }
  }

  const cliPath = resolveNativeCliPath(normalizedProvider, {
    env,
    appRoot: options.appRoot,
    cwd: options.cwd,
    runtimeToolsDir: options.runtimeToolsDir,
    spawnSyncImpl: options.spawnSyncImpl
  });
  if (!cliPath) {
    const error = new Error(`未找到 ${normalizedProvider} CLI`);
    error.code = 'cli_not_found';
    throw error;
  }

  return {
    command: cliPath,
    prefixArgs: []
  };
}

function computeDelta(previous, incoming, preferDirect = false) {
  const before = String(previous || '');
  const next = String(incoming || '');
  if (!next) return '';
  if (preferDirect) return next;
  if (!before) return next;
  if (next.startsWith(before)) return next.slice(before.length);
  return next;
}

function extractClaudeAssistantText(item) {
  const message = item && item.message && typeof item.message === 'object' ? item.message : null;
  const content = Array.isArray(message && message.content) ? message.content : [];
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function parseNativeStreamEvent(provider, line, state) {
  let parsed = null;
  try {
    parsed = JSON.parse(line);
  } catch (_error) {
    return null;
  }

  if (provider === 'gemini') {
    if (parsed && parsed.type === 'init' && parsed.session_id && !state.sessionId) {
      state.sessionId = String(parsed.session_id);
      return { type: 'session-created', sessionId: state.sessionId };
    }
    if (parsed && parsed.type === 'message' && parsed.role === 'assistant') {
      const text = String(parsed.content || '');
      const delta = computeDelta(state.content, text, parsed.delta === true);
      state.content += delta;
      return delta ? { type: 'delta', delta } : null;
    }
    if (parsed && parsed.type === 'result') {
      const resultText = normalizeString(parsed.result || '');
      const errorText = normalizeString(
        (parsed.error && parsed.error.message)
        || parsed.message
        || resultText
      );
      if (resultText && !state.content) state.content = resultText;
      if (parsed.status === 'error') {
        state.failureMessage = errorText || 'gemini_stream_failed';
        return { type: 'error', message: state.failureMessage };
      }
      return { type: 'result', content: state.content || resultText };
    }
    return null;
  }

  if (provider === 'claude') {
    if (parsed && parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id && !state.sessionId) {
      state.sessionId = String(parsed.session_id);
      return { type: 'session-created', sessionId: state.sessionId };
    }
    if (parsed && parsed.type === 'assistant') {
      const text = extractClaudeAssistantText(parsed);
      const delta = computeDelta(state.content, text, false);
      state.content += delta;
      return delta ? { type: 'delta', delta } : null;
    }
    if (parsed && parsed.type === 'result') {
      const resultText = normalizeString(parsed.result || '');
      if (resultText && !state.content) state.content = resultText;
      if (parsed.is_error) {
        return { type: 'error', message: resultText || 'claude_stream_failed' };
      }
      return { type: 'result', content: state.content || resultText };
    }
    return null;
  }

  if (provider === 'codex') {
    if (parsed && parsed.type === 'session_meta' && parsed.payload && parsed.payload.id && !state.sessionId) {
      state.sessionId = String(parsed.payload.id);
      return { type: 'session-created', sessionId: state.sessionId };
    }
    if (parsed && parsed.type === 'thread.started' && parsed.thread_id && !state.sessionId) {
      state.sessionId = String(parsed.thread_id);
      return { type: 'session-created', sessionId: state.sessionId };
    }
    if (parsed && parsed.type === 'item.completed' && parsed.item && parsed.item.type === 'agent_message') {
      const text = String(parsed.item.text || '');
      const delta = computeDelta(state.content, text, false);
      state.content += delta;
      return delta ? { type: 'delta', delta } : null;
    }
    return null;
  }

  if (provider === 'opencode') {
    if (parsed && parsed.sessionID && !state.sessionId) {
      state.sessionId = String(parsed.sessionID);
      return { type: 'session-created', sessionId: state.sessionId };
    }
    if (parsed && parsed.type === 'step_start') {
      return IGNORED_NATIVE_STREAM_EVENT;
    }
    if (parsed && parsed.type === 'text' && parsed.part && typeof parsed.part.text === 'string') {
      const text = String(parsed.part.text || '');
      const delta = computeDelta(state.content, text, false);
      state.content += delta;
      return delta ? { type: 'delta', delta } : null;
    }
    if (parsed && parsed.type === 'step_finish') {
      const reason = normalizeString(parsed.part && parsed.part.reason);
      if (OPENCODE_NON_TERMINAL_STEP_REASONS.has(reason)) {
        return IGNORED_NATIVE_STREAM_EVENT;
      }
      if (reason && reason !== 'stop') {
        state.failureMessage = reason;
        return { type: 'error', message: reason };
      }
      return { type: 'result', content: state.content };
    }
    if (parsed && parsed.type === 'error') {
      const message = normalizeString(parsed.message || parsed.error);
      state.failureMessage = message || 'opencode_stream_failed';
      return { type: 'error', message: state.failureMessage };
    }
    return null;
  }

  return null;
}

// agy 快路径句柄：对暖机 LS 发 agentapi send-message + 轮询 brain 取回复（~3-4s），
// 不拉新 pty。暖机 LS 失效（send-message 失败）则回退 coldSpawn() 冷启动。
// 返回的句柄与 spawnNativeSessionStream 同构（runId/done/writeInput/resize/abort），
// 调用方（webui-chat-routes）无需区分快慢路径。
function startAgyWarmResume(opts = {}) {
  const runId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `native-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let coldHandle = null;
  let aborted = false;

  const done = (async () => {
    if (aborted) {
      const e = new Error('native_session_aborted');
      e.code = 'native_session_aborted';
      throw e;
    }
    const result = await agyWarmPool.runWarmResume({
      accountKey: opts.accountKey,
      conversationId: opts.sessionId,
      prompt: opts.prompt,
      // 原始 brain transcript 路径——按新增 PLANNER_RESPONSE 判定本轮完成。
      transcriptPath: resolveSessionFilePath('agy', { sessionId: opts.sessionId })
    });

    if (result.warm && !result.timedOut && result.content) {
      return {
        content: result.content,
        afterMessages: Array.isArray(result.messages) ? result.messages : [],
        sessionId: opts.sessionId
      };
    }

    // send-message 成功但回复超时：消息已派发给 LS，不能冷启动重发（会重复），按失败处理。
    if (result.warm) {
      const e = new Error('native_session_transcript_not_updated');
      e.code = 'native_session_transcript_not_updated';
      throw e;
    }

    // 暖机 LS 不可用（send-message 失败 / 已被剔除）→ 回退冷启动（会重新拉起并收编暖机 LS）。
    if (aborted || typeof opts.coldSpawn !== 'function') {
      const e = new Error('native_session_failed');
      e.code = 'native_session_failed';
      throw e;
    }
    coldHandle = opts.coldSpawn();
    return coldHandle.done;
  })();

  return {
    runId,
    get child() {
      return coldHandle ? coldHandle.child : null;
    },
    done,
    writeInput(input, writeOptions = {}) {
      if (coldHandle && typeof coldHandle.writeInput === 'function') {
        return coldHandle.writeInput(input, writeOptions);
      }
      const error = new Error('native_session_run_not_active');
      error.code = 'native_session_run_not_active';
      throw error;
    },
    resize(cols, rows) {
      if (coldHandle && typeof coldHandle.resize === 'function') {
        coldHandle.resize(cols, rows);
      }
    },
    abort() {
      aborted = true;
      if (coldHandle && typeof coldHandle.abort === 'function') {
        coldHandle.abort();
      }
    }
  };
}

function spawnNativeSessionStream(options = {}) {
  const provider = normalizeString(options.provider).toLowerCase();
  const accountId = normalizeString(options.accountId);
  const prompt = String(options.prompt || '');
  const initialInput = String(options.initialInput || '');
  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths : [];
  const projectPath = normalizeString(options.projectPath) || process.cwd();
  const requestedSessionId = normalizeString(options.sessionId);
  const generatedSessionId = !requestedSessionId && (provider === 'gemini' || provider === 'claude')
    ? (typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `native-session-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    : '';
  const sessionParams = {
    sessionId: requestedSessionId || generatedSessionId,
    projectDirName: normalizeString(options.projectDirName)
  };
  const isResume = Boolean(requestedSessionId);
  const interactiveCli = !!options.interactiveCli;
  const getProfileDir = options.getProfileDir;
  // gemini 的 resume 走 `--session-file`，实际行为是 fork 出一个 import 了原会话历史的
  // 【新】会话（新 sessionId、同 projectHash），本轮回复落在新文件、而非被 resume 的旧文件
  // （gemini CLI 不会向 --session-file 指向的旧文件追加）。因此 gemini resume 要像 create
  // 一样处理：记录运行前的会话集合，运行后用 inferCreatedSessionId 推断并采纳这个新会话，
  // 否则 WebUI 一直盯着旧 sessionId 的 transcript → 永远等不到更新 → 120s 超时卡“正在连接”。
  const geminiSessionFileResume = provider === 'gemini' && isResume;

  if (!isOfficialNativeSessionProvider(provider)) {
    const error = new Error('native_session_start_unsupported');
    error.code = 'native_session_start_unsupported';
    throw error;
  }
  if (!provider || !accountId || typeof getProfileDir !== 'function') {
    const error = new Error('native_session_invalid_context');
    error.code = 'native_session_invalid_context';
    throw error;
  }

  if (typeof options.ensureSessionStoreLinks === 'function') {
    try {
      options.ensureSessionStoreLinks(provider, accountId);
    } catch (_error) {}
  }

  const profileDir = getProfileDir(provider, accountId);
  const sessionPath = sessionParams.sessionId ? resolveSessionFilePath(provider, sessionParams) : '';
  const beforeMessages = sessionParams.sessionId ? readSessionMessages(provider, sessionParams) : [];
  const beforeMtime = getSessionFileMtime(sessionPath);
  const env = buildProviderEnv(provider, profileDir, options.env);
  const launch = resolveNativeCliLaunch(provider, {
    claudeCliJsPath: options.claudeCliJsPath,
    env
  });
  const command = isResume ? buildResumeCommand : buildStartCommand;
  const { args } = command(provider, {
    sessionId: sessionParams.sessionId,
    prompt,
    imagePaths,
    model: options.model,
    interactiveCli,
    projectPath
  });

  // agy 快路径：该账号已有暖机 LS 时，resume 轮次直接走 agentapi send-message（~3-4s），
  // 跳过 ~100s 冷启动。冷启动只发生在新建会话、或暖机 LS 不存在/已失效的首轮。
  if (
    provider === 'agy'
    && isResume
    && requestedSessionId
    && !options.__forceColdSpawn
    && agyWarmPool.hasWarm(profileDir)
  ) {
    return startAgyWarmResume({
      accountKey: profileDir,
      sessionId: requestedSessionId,
      prompt,
      onEvent: options.onEvent,
      // 暖机 LS 不可用（send-message 失败）时回退冷启动；强制跳过 warm 分支避免递归。
      coldSpawn: () => spawnNativeSessionStream({ ...options, __forceColdSpawn: true })
    });
  }

  const batchLaunch = resolveWindowsBatchLaunch(
    provider,
    launch.command,
    env,
    process.platform
  );
  const finalLaunch = buildPtyLaunch(
    batchLaunch.launchBin || launch.command,
    [...launch.prefixArgs, ...args],
    { platform: process.platform }
  );
  const nodePty = loadNodePty();
  const child = nodePty.spawn(finalLaunch.command, finalLaunch.args, {
    name: 'xterm-color',
    cols: DEFAULT_NATIVE_STREAM_COLS,
    rows: DEFAULT_NATIVE_STREAM_ROWS,
    cwd: projectPath,
    env: {
      ...env,
      ...(batchLaunch.envPatch || {})
    }
  });

  const runId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `native-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const state = {
    content: '',
    stderr: '',
    stdout: '',
    sessionId: sessionParams.sessionId,
    failureMessage: ''
  };
  const startedAt = Date.now();
  const beforeSessionIds = (!isResume && !sessionParams.sessionId) || geminiSessionFileResume
    ? listProviderSessionFiles(provider, {
      projectDirName: sessionParams.projectDirName
    }).map((item) => item.id)
    : [];
  let lineBuffer = '';
  let pendingTerminal = '';
  let flushTimer = null;
  let settled = false;
  let runtimeBlockRecorded = false;
  let ignoreChildOutput = false; // agy 收编为暖机 LS 后置 true：停止累积该 pty 的交互输出
  const interactivePromptDetector = createInteractivePromptDetector(provider);
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const fail = (error) => {
    if (settled) return;
    settled = true;
    if (flushTimer) clearTimeout(flushTimer);
    rejectDone(error);
  };
  const finish = async (exitCode) => {
    if (settled) return;
    settled = true;
    if (flushTimer) clearTimeout(flushTimer);
    if (shouldScanNativeRuntimeBlockerOutput({ exitCode }) && !runtimeBlockRecorded) {
      recordRuntimeBlockFromOutput(
        normalizeString(state.failureMessage)
        || normalizeString(state.stderr)
        || normalizeString(state.stdout)
      );
    }
    if (runtimeBlockRecorded) {
      const error = new Error(normalizeString(state.failureMessage) || 'native_runtime_blocked');
      error.code = 'native_runtime_blocked';
      error.retryAnotherAccount = false;
      error.exitCode = exitCode;
      rejectDone(error);
      return;
    }
    if (Number(exitCode) !== 0) {
      const classifiedFailure = classifyNativeSessionFailure(
        provider,
        normalizeString(state.failureMessage) || normalizeString(state.stderr) || normalizeString(state.stdout)
      );
      const error = new Error(classifiedFailure.message || `native_session_failed_exit_${exitCode}`);
      error.code = classifiedFailure.code || 'native_session_failed';
      error.retryAnotherAccount = classifiedFailure.retryAnotherAccount === true;
      error.exitCode = exitCode;
      rejectDone(error);
      return;
    }

    const afterMessages = (isResume || (interactiveCli && state.sessionId))
      ? await waitForSessionUpdate(
        provider,
        {
          sessionId: state.sessionId || sessionParams.sessionId,
          projectDirName: sessionParams.projectDirName
        },
        beforeMessages.length,
        state.sessionId && state.sessionId !== sessionParams.sessionId
          ? resolveSessionFilePath(provider, {
            sessionId: state.sessionId,
            projectDirName: sessionParams.projectDirName
          })
          : sessionPath,
        beforeMtime
      )
      : [];
    if (!isResume && provider === 'claude' && !state.sessionId) {
      const inferredSessionId = await inferClaudeCreatedSessionId(sessionParams.projectDirName, {
        beforeSessionIds,
        startedAt,
        prompt: initialInput || prompt
      });
      if (inferredSessionId) {
        state.sessionId = inferredSessionId;
        emitEvent({ type: 'session-created', sessionId: inferredSessionId });
      }
    }
    const finalContent = state.content || collectAssistantReply(beforeMessages, afterMessages);
    resolveDone({
      content: finalContent,
      afterMessages,
      sessionId: state.sessionId || ''
    });
  };

  const emitEvent = (event) => {
    if (!event || typeof options.onEvent !== 'function') return;
    options.onEvent({
      ...event,
      runId
    });
  };

  const recordRuntimeBlockFromOutput = (text) => {
    if (runtimeBlockRecorded) return null;
    const blocker = classifyNativeAccountRuntimeBlocker(provider, text);
    if (!blocker) return null;
    runtimeBlockRecorded = true;
    const persisted = recordNativeAccountRuntimeBlocker({
      ...options,
      provider,
      accountId,
      profileDir
    }, blocker);
    state.failureMessage = blocker.message || blocker.reason || 'native_runtime_blocked';
    emitEvent({
      type: 'runtime-blocked',
      provider,
      accountId,
      status: blocker.status,
      reason: blocker.reason,
      persisted
    });
    return blocker;
  };

  const completeFromOfficialTranscript = async () => {
    if (!interactiveCli || options.completeOnTranscriptUpdate === false) return;
    // gemini fork 出的新会话只含【本轮】对话，不展开 import 的旧历史，因此它相对于旧会话
    // 的消息数并不递增（无法用 before/after 计数比对）。对 gemini fork 把 before 视为空，
    // 让“新会话里出现 assistant 回复”即判定本轮完成。
    const effectiveBeforeMessages = geminiSessionFileResume ? [] : beforeMessages;
    const result = await waitForOfficialTranscriptTurn(
      provider,
      {
        // gemini resume 会 fork 新会话：清空 sessionId 强制走 inferCreatedSessionId，
        // 据 beforeSessionIds + prompt 文本命中那个新会话并读取回复。
        sessionId: geminiSessionFileResume ? '' : (state.sessionId || sessionParams.sessionId),
        projectDirName: sessionParams.projectDirName,
        // codex 用 cwd 走 state DB 推断 sessionId（projectPath = 子进程 cwd）。
        cwd: projectPath
      },
      effectiveBeforeMessages,
      {
        beforeSessionIds,
        startedAt,
        prompt: initialInput || prompt,
        // gemini fork 必须等到含本轮 prompt 的会话出现，避免采纳到只含导入旧历史的早期 fork。
        requirePromptMatch: geminiSessionFileResume,
        timeoutMs: options.officialTranscriptTimeoutMs
      }
    );
    if (settled) return;
    // gemini fork resume：state.sessionId 初始化为源会话 id（resume 目标），但本轮真正写入
    // 回复的是 fork 出的新会话。必须用 fork id 覆盖，前端据此采纳新会话，下一轮才会 resume
    // 含本轮上下文的 fork、而非反复 import 源会话丢失中间轮。
    if (result.sessionId && (!state.sessionId || geminiSessionFileResume)) {
      state.sessionId = result.sessionId;
      emitEvent({ type: 'session-created', sessionId: result.sessionId });
    }
    const content = state.content || collectAssistantReply(effectiveBeforeMessages, result.afterMessages);
    settled = true;
    if (flushTimer) clearTimeout(flushTimer);
    resolveDone({
      content,
      afterMessages: result.afterMessages,
      sessionId: state.sessionId || result.sessionId || ''
    });
    // agy：本轮跑完后【不杀进程】，把存活的 agy 进程收编为该账号的暖机 LS，
    // 后续 resume 走 send-message 快路径（见 startAgyWarmResume）。其余 provider 照常结束。
    if (provider === 'agy' && child && typeof child.kill === 'function') {
      ignoreChildOutput = true; // 收编后不再累积该 pty 的交互输出（避免内存随暖机 LS 寿命增长）
      agyWarmPool.adopt({
        accountKey: profileDir,
        child,
        agyBin: launch.command,
        baseEnv: env,
        projectId: resolveAgyProjectId(projectPath)
      }).then((adopted) => {
        if (!adopted) {
          try { child.kill(); } catch (_error) {}
        }
      }).catch(() => {
        try { child.kill(); } catch (_error) {}
      });
    } else if (child && typeof child.kill === 'function') {
      try {
        child.kill();
      } catch (_error) {}
    }
  };

  const flushTerminal = () => {
    flushTimer = null;
    const text = pendingTerminal;
    pendingTerminal = '';
    if (!text.trim()) return;
    emitEvent({
      type: 'terminal-output',
      text
    });
  };

  const scheduleTerminalFlush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushTerminal, 120);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  };

  const pushTerminalText = (text) => {
    const normalized = sanitizeTerminalText(text);
    if (!normalized) return;
    pendingTerminal += normalized;
    scheduleTerminalFlush();
  };

  child.onData((chunk) => {
    if (ignoreChildOutput) return; // 已收编为暖机 LS，pty 自身输出与本次会话无关
    const text = String(chunk || '');
    state.stdout += text;
    if (interactiveCli) {
      const runtimeBlocker = shouldScanNativeRuntimeBlockerOutput({ interactiveCli })
        ? recordRuntimeBlockFromOutput(text)
        : null;
      if (runtimeBlocker) {
        try {
          child.kill();
        } catch (_error) {}
      }
      const promptEvent = interactivePromptDetector.appendOutput(text);
      if (promptEvent) {
        emitEvent(promptEvent);
      }
      if (options.emitTerminalOutput !== false) {
        emitEvent({
          type: 'terminal-output',
          text
        });
      }
      return;
    }
    lineBuffer += sanitizeTerminalText(text);

    while (true) {
      const newlineIndex = lineBuffer.indexOf('\n');
      if (newlineIndex < 0) break;
      const rawLine = lineBuffer.slice(0, newlineIndex).replace(/\r/g, '');
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      const trimmedLine = rawLine.trim();
      if (!trimmedLine) {
        pushTerminalText('\n');
        continue;
      }
      const event = parseNativeStreamEvent(provider, trimmedLine, state);
      if (event) {
        if (shouldScanNativeRuntimeBlockerOutput({ explicitError: event.type === 'error' })) {
          recordRuntimeBlockFromOutput(event.message || state.failureMessage || trimmedLine);
        }
        if (event.type !== IGNORED_NATIVE_STREAM_EVENT.type) {
          emitEvent(event);
        }
        continue;
      }
      pushTerminalText(`${rawLine}\n`);
    }

    const trailing = lineBuffer.trim();
    if (trailing && !trailing.startsWith('{"')) {
      pushTerminalText(lineBuffer);
      lineBuffer = '';
    }
  });
  child.onExit(({ exitCode }) => {
    const promptClearedEvent = interactivePromptDetector.clearActivePrompt('run-finished');
    if (promptClearedEvent) {
      emitEvent(promptClearedEvent);
    }
    if (lineBuffer.trim()) {
      pushTerminalText(lineBuffer);
      lineBuffer = '';
    }
    if (pendingTerminal) {
      flushTerminal();
    }
    finish(exitCode).catch(fail);
  });

  if (interactiveCli && initialInput) {
    try {
      writePtyInput(child, initialInput, { appendNewline: true });
    } catch (_error) {}
  }

  if (!isResume && sessionParams.sessionId) {
    setImmediate(() => {
      if (!settled) {
        emitEvent({ type: 'session-created', sessionId: sessionParams.sessionId });
      }
    });
  }

  completeFromOfficialTranscript().catch((error) => {
    if (settled) return;
    fail(error);
    if (child && typeof child.kill === 'function') {
      try {
        child.kill();
      } catch (_killError) {}
    }
  });

  return {
    runId,
    child,
    done,
    writeInput(input, writeOptions = {}) {
      if (settled) {
        const error = new Error('native_session_run_not_active');
        error.code = 'native_session_run_not_active';
        throw error;
      }
      const rawInput = String(input || '');
      if (!rawInput) {
        const error = new Error('native_session_input_empty');
        error.code = 'native_session_input_empty';
        throw error;
      }
      const promptId = normalizeString(writeOptions.promptId);
      if (promptId) {
        const activePrompt = interactivePromptDetector.getActivePrompt();
        if (!activePrompt || activePrompt.promptId !== promptId) {
          const error = new Error('native_interactive_prompt_not_active');
          error.code = 'native_interactive_prompt_not_active';
          throw error;
        }
      }
      const promptClearedEvent = interactivePromptDetector.clearActivePrompt('input-submitted');
      if (promptClearedEvent) {
        emitEvent(promptClearedEvent);
      }
      writePtyInput(child, rawInput, {
        appendNewline: writeOptions.appendNewline !== false
      });
    },
    resize(cols, rows) {
      if (settled) {
        const error = new Error('native_session_run_not_active');
        error.code = 'native_session_run_not_active';
        throw error;
      }
      const nextCols = Math.max(20, Math.min(400, Number(cols) || 80));
      const nextRows = Math.max(4, Math.min(200, Number(rows) || 24));
      if (typeof child.resize === 'function') {
        child.resize(nextCols, nextRows);
      }
    },
    abort() {
      if (flushTimer) clearTimeout(flushTimer);
      if (child && typeof child.kill === 'function') {
        try {
          child.kill();
        } catch (_error) {}
      }
    }
  };
}

async function waitForSessionUpdate(provider, params, beforeCount, sessionPath, beforeMtime = 0, timeoutMs = 10000) {
  const startedAt = Date.now();
  const initialMtime = Number(beforeMtime) || 0;

  while (Date.now() - startedAt < timeoutMs) {
    const currentMessages = readSessionMessages(provider, params);
    const currentMtime = sessionPath && fs.existsSync(sessionPath)
      ? Number(fs.statSync(sessionPath).mtimeMs) || 0
      : 0;
    if (currentMessages.length > beforeCount || currentMtime > initialMtime) {
      return currentMessages;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return readSessionMessages(provider, params);
}

function collectAssistantReply(beforeMessages, afterMessages) {
  const offset = Array.isArray(beforeMessages) ? beforeMessages.length : 0;
  const nextMessages = Array.isArray(afterMessages) ? afterMessages.slice(offset) : [];
  return nextMessages
    .filter((message) => message && message.role === 'assistant')
    .map((message) => String(message.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function hasAssistantAddition(beforeMessages, afterMessages) {
  const offset = Array.isArray(beforeMessages) ? beforeMessages.length : 0;
  const nextMessages = Array.isArray(afterMessages) ? afterMessages.slice(offset) : [];
  return nextMessages.some((message) => message && message.role === 'assistant' && String(message.content || '').trim());
}

async function waitForOfficialTranscriptTurn(provider, params = {}, beforeMessages = [], options = {}) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 120000);
  const startedAt = Number(options.startedAt) || Date.now();
  const prompt = String(options.prompt || '');
  const beforeSessionIds = Array.isArray(options.beforeSessionIds) ? options.beforeSessionIds : [];
  const requirePromptMatch = options.requirePromptMatch === true;
  const deadline = Date.now() + timeoutMs;
  let sessionId = normalizeString(params.sessionId);
  let afterMessages = [];

  if (!sessionId && beforeSessionIds.length > 0) {
    sessionId = await inferCreatedSessionId(normalizedProvider, {
      beforeSessionIds,
      startedAt,
      prompt,
      requirePromptMatch,
      projectDirName: params.projectDirName,
      cwd: params.cwd,
      hostHome: options.hostHome,
      timeoutMs: Math.min(timeoutMs, 10000)
    });
  }

  while (Date.now() < deadline) {
    if (!sessionId && beforeSessionIds.length > 0) {
      sessionId = await inferCreatedSessionId(normalizedProvider, {
        beforeSessionIds,
        startedAt,
        prompt,
        requirePromptMatch,
        projectDirName: params.projectDirName,
        cwd: params.cwd,
        hostHome: options.hostHome,
        timeoutMs: 500
      });
    }

    if (sessionId) {
      afterMessages = readSessionMessages(normalizedProvider, {
        sessionId,
        projectDirName: params.projectDirName
      });
      if (hasAssistantAddition(beforeMessages, afterMessages)) {
        return { sessionId, afterMessages };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const error = new Error('native_session_transcript_not_updated');
  error.code = 'native_session_transcript_not_updated';
  error.sessionId = sessionId;
  error.afterMessages = afterMessages;
  throw error;
}

async function runNativeSessionPrompt(options = {}) {
  const provider = normalizeString(options.provider).toLowerCase();
  const accountId = normalizeString(options.accountId);
  const prompt = String(options.prompt || '');
  const getProfileDir = options.getProfileDir;

  if (!provider || !accountId || typeof getProfileDir !== 'function') {
    const error = new Error('native_session_invalid_context');
    error.code = 'native_session_invalid_context';
    throw error;
  }

  const stream = spawnNativeSessionStream({
    ...options,
    prompt,
    interactiveCli: provider !== 'claude',
    emitTerminalOutput: false,
    completeOnTranscriptUpdate: provider !== 'claude'
  });
  const result = await stream.done;

  return {
    ok: true,
    provider,
    accountId,
    sessionId: result.sessionId || normalizeString(options.sessionId),
    content: result.content || '',
    beforeCount: 0,
    afterCount: Array.isArray(result.afterMessages) ? result.afterMessages.length : 0
  };
}

// 派生一个会话标题（用于 codex session_index）：取 prompt 首个非空行，截断。
function deriveCodexThreadName(prompt) {
  const firstLine = String(prompt || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
  const title = firstLine.slice(0, 60).trim();
  // codex reader 会把 '未命名会话'/'Warmup' 过滤掉，必须给一个非空且非这两者的标题。
  if (!title || title === '未命名会话' || title === 'Warmup') return '';
  return title;
}

// codex 用 prompt 作为标题写入 session_index.jsonl，避免新会话因 title 解析为
// '未命名会话' 被 readCodexProjectsFromHost / readCodexThreadsFromStateDb 过滤掉而在
// 列表里不可见。仅用于 WebUI 新建的 codex 会话（resume 不应改写已有标题）。
function ensureCodexSessionIndexEntry(options = {}) {
  const sessionId = normalizeString(options.sessionId);
  const title = deriveCodexThreadName(options.prompt);
  if (!sessionId || !title) return false;
  const hostHome = normalizeString(options.hostHome) || getRealHome();
  const indexPath = path.join(hostHome, '.codex', 'session_index.jsonl');
  try {
    // 已有同 id 的条目则不重复写（codex 自己可能也写了）。
    if (fs.existsSync(indexPath)) {
      const existing = fs.readFileSync(indexPath, 'utf8');
      if (existing.includes(`"id":"${sessionId}"`) || existing.includes(`"id": "${sessionId}"`)) {
        return false;
      }
    } else {
      fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    }
    const line = JSON.stringify({
      id: sessionId,
      thread_name: title,
      updated_at: new Date().toISOString()
    });
    fs.appendFileSync(indexPath, `${line}\n`, 'utf8');
    return true;
  } catch (_error) {
    return false;
  }
}

// agy(antigravity）会话存储里没有 cwd/项目信息，所以 WebUI 建会话时把 sessionId→projectPath
// 映射写进一个 sidecar 索引，供 readAgyProjectsFromHost 把 agy 会话按项目归类、入列表。
function agySessionProjectIndexPath(hostHome = getRealHome()) {
  return path.join(hostHome, '.gemini', 'antigravity-cli', 'aih-session-projects.json');
}

function readAgySessionProjectIndex(hostHome = getRealHome()) {
  const indexPath = agySessionProjectIndexPath(hostHome);
  try {
    if (!fs.existsSync(indexPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

// agentapi send-message 需要 ANTIGRAVITY_PROJECT_ID。antigravity CLI 把 workspace 路径→uuid
// 的映射缓存在 ~/.gemini/antigravity-cli/cache/projects.json，这里按 projectPath 反查。
function resolveAgyProjectId(projectPath, hostHome = getRealHome()) {
  const wanted = normalizeString(projectPath);
  if (!wanted) return '';
  const cachePath = path.join(hostHome, '.gemini', 'antigravity-cli', 'cache', 'projects.json');
  try {
    if (!fs.existsSync(cachePath)) return '';
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return '';
    // 结构容错：可能是 { "<path>": "<uuid>" } 或 { projects: { "<path>": {id} } } 等。
    const direct = parsed[wanted];
    if (typeof direct === 'string') return direct;
    if (direct && typeof direct === 'object' && direct.id) return String(direct.id);
    const table = parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : parsed;
    for (const [key, value] of Object.entries(table)) {
      if (key !== wanted) continue;
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object' && (value.id || value.projectId)) {
        return String(value.id || value.projectId);
      }
    }
  } catch (_error) { /* best effort */ }
  return '';
}

function ensureAgySessionProjectIndex(options = {}) {
  const sessionId = normalizeString(options.sessionId);
  const projectPath = normalizeString(options.projectPath);
  if (!sessionId || !projectPath) return false;
  const hostHome = normalizeString(options.hostHome) || getRealHome();
  const indexPath = agySessionProjectIndexPath(hostHome);
  try {
    const current = readAgySessionProjectIndex(hostHome);
    const existing = current[sessionId];
    const entry = { projectPath, updatedAt: new Date().toISOString() };
    if (existing && existing.projectPath === projectPath) return false;
    current[sessionId] = entry;
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify(current, null, 2), 'utf8');
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  DEFAULT_NATIVE_STREAM_COLS,
  ensureCodexSessionIndexEntry,
  inferCodexSessionIdFromStateDb,
  ensureAgySessionProjectIndex,
  resolveAgyProjectId,
  DEFAULT_NATIVE_STREAM_ROWS,
  buildProviderEnv,
  buildPtyInputChunks,
  buildStartCommand,
  buildResumeCommand,
  resolveNativeCliLaunch,
  classifyNativeSessionFailure,
  classifyNativeAccountRuntimeBlocker,
  shouldScanNativeRuntimeBlockerOutput,
  recordNativeAccountRuntimeBlocker,
  collectAssistantReply,
  inferClaudeCreatedSessionId,
  isOfficialNativeSessionProvider,
  parseNativeStreamEvent,
  runNativeSessionPrompt,
  spawnNativeSessionStream
};
