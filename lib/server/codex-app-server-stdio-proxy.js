'use strict';

const { spawn } = require('node:child_process');
const childProcess = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { repairCodexSessionVisibility } = require('../cli/services/ai-cli/codex-session-visibility-repair');
const { startCodexCliResumeCwdProxy } = require('./codex-cli-resume-proxy');
const { rewriteCodexAppServerClientMessage } = require('./codex-app-server-proxy');
const { postJson } = require('./provider-session-hook-sender');
const {
  rememberThreadResumeRequest,
  patchThreadResumeResponseMessage
} = require('./codex-thread-resume-response-patch');
const {
  readCodexSessionNotificationsSince,
  resolveCodexSessionNotificationQueuePathFromStateFile
} = require('./codex-session-notification-queue');
const { readServerConfig } = require('./server-config-store');
const { resolveHostHomeDir } = require('../runtime/host-home');
const {
  decodeEncodedWindowsPath,
  normalizeWindowsPathForCodexConfig
} = require('../runtime/windows-path-encoding');
const {
  CODEX_DESKTOP_AUTH_TYPES,
  buildCodexDesktopRuntimeAuth,
  resolveAiHomeDir,
  resolveCodexDesktopAccountIdentity,
  resolveCodexDesktopChatGptAccount,
  resolveCodexDesktopChatGptIdentity
} = require('./codex-desktop-account');
const AGGREGATE_THREAD_LIST_MAX_PAGES = 3;
const AGGREGATE_THREAD_LIST_MAX_ITEMS = 80;
const TRACE_THREAD_LIST_SUMMARY_ITEMS = 10;
const FAST_THREAD_READ_MIN_BYTES = 8 * 1024 * 1024;
const FAST_THREAD_READ_TURN_LIMIT = 20;
const FAST_THREAD_READ_INITIAL_BYTES = 2 * 1024 * 1024;
const FAST_THREAD_READ_MAX_BYTES = 8 * 1024 * 1024;
const FAST_THREAD_READ_MAX_COMMAND_OUTPUT_CHARS = 16 * 1024;
const STALE_IN_PROGRESS_TURN_AFTER_MS = 30 * 60 * 1000;
const REMOTE_HYDRATION_SUPPRESSION_TTL_MS = 2 * 60 * 1000;
const SESSION_NOTIFICATION_POLL_INTERVAL_MS = 500;
const SESSION_NOTIFICATION_DEBOUNCE_MS = 500;
const OPTIMIZED_ROLLOUT_REPAIR_INTERVAL_MS = 30 * 1000;
const MISSING_THREAD_TITLE_REPAIR_INTERVAL_MS = 30 * 1000;
const THREAD_TITLE_REPAIR_LIMIT = 200;
const THREAD_TITLE_REPAIR_MAX_BYTES = 16 * 1024 * 1024;
const PENDING_ACTIVE_TURN_ID = '__aih_pending_turn_start__';
const REMOTE_TRACE_METHODS = new Set([
  'account/read',
  'getAuthStatus',
  'plugin/list',
  'remoteControl/disable',
  'remoteControl/enable',
  'remoteControl/status/changed',
  'thread/goal/get',
  'thread/list',
  'thread/read',
  'thread/resume',
  'thread/start',
  'turn/interrupt',
  'turn/start',
  'turn/steer'
]);
const REMOTE_TRACE_STDERR_PATTERNS = [
  /remote[-_ ]control/i,
  /websocket/i,
  /enroll/i,
  /backend-api/i,
  /chatgpt authentication/i,
  /plugin\/list/i,
  /\b(?:401|403|429|5\d\d)\b/
];
const HYDRATION_NOTIFICATION_METHODS = new Set([
  'thread/started',
  'thread/status/changed',
  'thread/tokenUsage/updated'
]);
const LIVE_THREAD_TURN_METHODS = new Set([
  'turn/start',
  'turn/steer'
]);
let DatabaseSyncCtor = null;
let didResolveDatabaseSync = false;

function parseProxyArgs(argv) {
  const input = Array.isArray(argv) ? [...argv] : [];
  const result = {
    upstream: '',
    stateFile: '',
    repairResumeVisibility: false,
    runCliResume: false,
    forwardArgs: []
  };
  let passthrough = false;
  for (let index = 0; index < input.length; index += 1) {
    const token = String(input[index] || '');
    if (passthrough) {
      result.forwardArgs.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }
    if (token === '--upstream') {
      result.upstream = String(input[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (token === '--state-file') {
      result.stateFile = String(input[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (token === '--repair-resume-visibility') {
      result.repairResumeVisibility = true;
      continue;
    }
    if (token === '--run-cli-resume') {
      result.runCliResume = true;
      continue;
    }
  }
  return result;
}

function readHookState(fs, stateFile) {
  const filePath = String(stateFile || '').trim();
  if (!filePath || !fs || typeof fs.existsSync !== 'function' || !fs.existsSync(filePath)) {
    return { enabled: false };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { enabled: false };
    return {
      enabled: parsed.enabled === true,
      traceFile: String(parsed.traceFile || '').trim(),
      traceResponses: parsed.traceResponses === true,
      traceRemoteControl: parsed.traceRemoteControl === true,
      remoteControlProxy: parsed.remoteControlProxy === true,
      providerHookReceiverUrl: String(parsed.providerHookReceiverUrl || '').trim(),
      sessionNotificationQueueFile: String(parsed.sessionNotificationQueueFile || '').trim(),
      desktopAccountId: /^\d+$/.test(String(parsed.desktopAccountId || '').trim())
        ? String(parsed.desktopAccountId).trim()
        : ''
    };
  } catch (_error) {
    return { enabled: false };
  }
}

function createTraceWriter(fs, state) {
  const traceFile = String(state && state.traceFile || '').trim();
  if (!traceFile) {
    return () => {};
  }
  return (entry) => {
    try {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        ...entry
      });
      fs.appendFileSync(traceFile, `${line}\n`);
    } catch (_error) {}
  };
}

function createLinePump(onLine) {
  let buffer = '';
  return {
    write(chunk) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach((line) => onLine(line));
    },
    flush() {
      if (buffer.length > 0) {
        onLine(buffer);
        buffer = '';
      }
    }
  };
}

function tryParseJson(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch (_error) {
    return null;
  }
}

function sanitizeTraceText(value, maxLength = 4000) {
  let text = String(value || '');
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
  text = text.replace(/"((?:access|refresh|id)_token|authToken|token)"\s*:\s*"[^"]+"/gi, '"$1":"[redacted]"');
  text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[jwt-redacted]');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function summarizeJsonRpcForTrace(payload) {
  const message = typeof payload === 'string' ? tryParseJson(payload) : payload;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { kind: 'unknown' };
  }
  const summary = {};
  if (Object.prototype.hasOwnProperty.call(message, 'id')) {
    summary.id = String(message.id);
  }
  const method = String(message.method || '').trim();
  if (method) summary.method = method;
  const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params)
    ? message.params
    : {};
  const thread = params.thread && typeof params.thread === 'object' && !Array.isArray(params.thread)
    ? params.thread
    : {};
  const threadId = String(params.threadId || params.thread_id || params.id || thread.id || '').trim();
  if (threadId) summary.threadId = threadId;
  if (method === 'thread/list') {
    if (Number.isFinite(Number(params.limit))) summary.limit = Number(params.limit);
    if (Object.prototype.hasOwnProperty.call(params, 'cursor')) {
      summary.cursor = params.cursor === null ? null : String(params.cursor || '');
    }
    if (params.sortKey) summary.sortKey = String(params.sortKey);
    if (Object.prototype.hasOwnProperty.call(params, 'archived')) summary.archived = params.archived === true;
    if (Array.isArray(params.modelProviders)) summary.modelProviders = params.modelProviders;
    if (Array.isArray(params.sourceKinds)) summary.sourceKinds = params.sourceKinds;
    summary.useStateDbOnly = params.useStateDbOnly === true;
    summary.hasCwd = Boolean(params.cwd);
  }
  if (method === 'remoteControl/status/changed') {
    summary.status = String(params.status || '').trim();
    summary.environmentId = String(params.environmentId || params.environment_id || '').trim();
    summary.installationId = String(params.installationId || params.installation_id || '').trim();
  }
  if (message.error) {
    summary.error = String(message.error.message || message.error.code || 'error');
  }
  if (message.result && typeof message.result === 'object' && !Array.isArray(message.result)) {
    summary.hasResult = true;
    if (Array.isArray(message.result.data)) {
      summary.resultDataLength = message.result.data.length;
      summary.nextCursor = message.result.nextCursor ? true : false;
      summary.resultThreads = message.result.data
        .map((item) => summarizeThreadListTraceItem(item))
        .filter(Boolean)
        .slice(0, TRACE_THREAD_LIST_SUMMARY_ITEMS);
      summary.resultThreadIds = summary.resultThreads.map((item) => item.id);
      if (message.result.nextCursor) summary.nextCursorValue = String(message.result.nextCursor);
      if (message.result.backwardsCursor) summary.backwardsCursorValue = String(message.result.backwardsCursor);
    }
    if (message.result.thread && typeof message.result.thread === 'object') {
      summary.resultThreadId = String(message.result.thread.id || '').trim() || undefined;
    }
  }
  return summary;
}

function summarizeThreadListTraceItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = String(item.id || item.sessionId || item.threadId || '').trim();
  if (!id) return null;
  const out = { id };
  const updatedAt = item.updatedAt || item.updated_at || item.updated_at_ms;
  const createdAt = item.createdAt || item.created_at || item.created_at_ms;
  if (updatedAt !== undefined && updatedAt !== null && updatedAt !== '') out.updatedAt = updatedAt;
  if (createdAt !== undefined && createdAt !== null && createdAt !== '') out.createdAt = createdAt;
  if (item.modelProvider) out.modelProvider = String(item.modelProvider);
  if (item.model_provider) out.modelProvider = String(item.model_provider);
  if (item.source) out.source = String(item.source);
  if (item.threadSource) out.threadSource = item.threadSource === null ? null : String(item.threadSource);
  if (item.thread_source) out.threadSource = String(item.thread_source);
  if (item.cwd) out.cwd = String(item.cwd);
  return out;
}

function isRemoteTracePayload(payload) {
  const message = typeof payload === 'string' ? tryParseJson(payload) : payload;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const method = String(message.method || '').trim();
  if (method && (method.startsWith('remoteControl/') || REMOTE_TRACE_METHODS.has(method))) return true;
  const text = JSON.stringify(message);
  return /remoteControl|remote[-_ ]control|websocket|backend-api/i.test(text);
}

function traceRemoteJsonRpc(writeTrace, state, direction, payload, extras = {}) {
  if (!state || state.traceRemoteControl !== true) return;
  if (!isRemoteTracePayload(payload)) return;
  writeTrace({
    direction,
    remoteControl: true,
    summary: summarizeJsonRpcForTrace(payload),
    ...extras
  });
}

function isRemoteTraceStderrLine(line) {
  const text = String(line || '').trim();
  if (!text) return false;
  return REMOTE_TRACE_STDERR_PATTERNS.some((pattern) => pattern.test(text));
}

function waitForReadyFile(fs, filePath, timeoutMs = 2500) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 2500);
  const waitBuffer = new SharedArrayBuffer(4);
  const waitArray = new Int32Array(waitBuffer);
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
      }
    } catch (_error) {
      return null;
    }
    Atomics.wait(waitArray, 0, 0, 50);
  }
  return null;
}

function getDatabaseSyncCtor() {
  if (didResolveDatabaseSync) return DatabaseSyncCtor;
  didResolveDatabaseSync = true;
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = require('node:sqlite'));
  } catch (_error) {
    DatabaseSyncCtor = null;
  }
  return DatabaseSyncCtor;
}

function readCurrentCodexConfig(fs, codexHome) {
  const configPath = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(configPath)) return { preferredAuthMethod: '', modelProvider: '', model: '' };
  try {
    const content = String(fs.readFileSync(configPath, 'utf8') || '');
    const authMethodMatch = content.match(/^preferred_auth_method\s*=\s*"([^"]+)"\s*$/m);
    const providerMatch = content.match(/^model_provider\s*=\s*"([^"]+)"\s*$/m);
    const modelMatch = content.match(/^model\s*=\s*"([^"]+)"\s*$/m);
    return {
      preferredAuthMethod: authMethodMatch ? String(authMethodMatch[1] || '').trim() : '',
      modelProvider: providerMatch ? String(providerMatch[1] || '').trim() : '',
      model: modelMatch ? String(modelMatch[1] || '').trim() : ''
    };
  } catch (_error) {
    return { preferredAuthMethod: '', modelProvider: '', model: '' };
  }
}

function hasCodexRuntimeConfig(config) {
  return Boolean(config && (config.preferredAuthMethod || config.modelProvider || config.model));
}

function resolveHostCodexHome(deps = {}) {
  const processObj = deps.processObj || process;
  const hostHome = resolveHostHomeDir({
    env: processObj.env || {},
    platform: processObj.platform,
    os: deps.os
  });
  return hostHome ? path.join(hostHome, '.codex') : '';
}

function readCurrentCodexRuntimeConfig(fs, codexHome, deps = {}) {
  const hostCodexHome = resolveHostCodexHome(deps);
  if (hostCodexHome && hostCodexHome !== codexHome) {
    const hostConfig = readCurrentCodexConfig(fs, hostCodexHome);
    if (hasCodexRuntimeConfig(hostConfig)) return hostConfig;
  }
  return readCurrentCodexConfig(fs, codexHome);
}

function isAihManagedProvider(providerId) {
  const normalized = String(providerId || '').trim();
  return normalized === 'aih' || /^aih_[A-Za-z0-9_-]+$/.test(normalized);
}

function isApiKeyRuntimeConfig(config) {
  return String(config && config.preferredAuthMethod || '').trim().toLowerCase() === 'apikey';
}

function escapeTomlString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function upsertTomlStringValue(text, key, value) {
  const normalizedKey = String(key || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(normalizedKey)) return String(text || '');
  const line = `${normalizedKey} = "${escapeTomlString(value)}"`;
  const source = String(text || '');
  const tableMatch = source.match(/^\s*\[/m);
  const rootEnd = tableMatch ? tableMatch.index : source.length;
  const rootSource = source.slice(0, rootEnd);
  const restSource = source.slice(rootEnd);
  const pattern = new RegExp(`^${normalizedKey}\\s*=\\s*"[^"\\n]*"\\s*$`, 'm');
  if (pattern.test(rootSource)) {
    return `${rootSource.replace(pattern, line)}${restSource}`;
  }
  const suffix = rootSource && !rootSource.endsWith('\n') ? '\n' : '';
  return `${rootSource}${suffix}${line}\n${restSource}`;
}

function ensureDirectory(fs, dirPath) {
  const target = String(dirPath || '').trim();
  if (!target || !fs || typeof fs.mkdirSync !== 'function') return false;
  try {
    fs.mkdirSync(target, { recursive: true });
    return true;
  } catch (_error) {
    return false;
  }
}

function writeJsonFilePrivate(fs, filePath, value) {
  if (!fs || typeof fs.writeFileSync !== 'function') return false;
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    if (typeof fs.chmodSync === 'function') {
      try { fs.chmodSync(filePath, 0o600); } catch (_chmodError) {}
    }
    return true;
  } catch (_error) {
    return false;
  }
}

function readJsonObjectFile(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function hasCodexApiKeyAuth(fs, codexHome) {
  const authJson = readJsonObjectFile(fs, path.join(codexHome, 'auth.json'));
  return Boolean(String(authJson && authJson.OPENAI_API_KEY || '').trim());
}

function buildCodexAppServerRuntimeConfig(fs, hostCodexHome, options = {}) {
  const configPath = path.join(hostCodexHome, 'config.toml');
  let content = '';
  try {
    if (fs.existsSync(configPath)) {
      content = String(fs.readFileSync(configPath, 'utf8') || '');
    }
  } catch (_error) {
    content = '';
  }
  content = upsertTomlStringValue(
    content,
    'sqlite_home',
    normalizeWindowsPathForCodexConfig(hostCodexHome)
  );
  content = upsertTomlStringValue(content, 'cli_auth_credentials_store', 'file');
  const chatgptBaseUrl = String(options.chatgptBaseUrl || '').trim();
  if (chatgptBaseUrl) {
    content = upsertTomlStringValue(content, 'chatgpt_base_url', chatgptBaseUrl);
  }
  return content;
}

function buildCodexAppServerHostHomeRuntime(hostCodexHome) {
  return {
    runtimeHome: hostCodexHome,
    hostCodexHome,
    accountId: '',
    authType: CODEX_DESKTOP_AUTH_TYPES.API_KEY,
    usesHostHome: true,
    env: {
      CODEX_HOME: hostCodexHome,
      CODEX_SQLITE_HOME: hostCodexHome
    }
  };
}

function prepareCodexAppServerRuntimeHome(fs, state, deps = {}) {
  const processObj = deps.processObj || process;
  const hostCodexHome = resolveCodexStateHome({ processObj });
  if (!hostCodexHome) return null;

  const currentConfig = readCurrentCodexRuntimeConfig(fs, hostCodexHome, deps);
  if (!isAihManagedProvider(currentConfig.modelProvider)) return null;
  if (isApiKeyRuntimeConfig(currentConfig) || hasCodexApiKeyAuth(fs, hostCodexHome)) {
    return buildCodexAppServerHostHomeRuntime(hostCodexHome);
  }

  const identity = resolveCodexDesktopAccountIdentity(fs, {
    ...deps,
    desktopAccountId: state && state.desktopAccountId
  });
  const runtimeAuth = buildCodexDesktopRuntimeAuth(identity);
  if (!identity || !runtimeAuth) return null;

  const aiHomeDir = resolveAiHomeDir({ processObj, os: deps.os });
  if (!aiHomeDir) return null;
  const runtimeHome = path.join(aiHomeDir, 'codex-desktop-runtime', `app-server-${identity.id}`);
  if (!ensureDirectory(fs, runtimeHome)) return null;

  const runtimeConfig = buildCodexAppServerRuntimeConfig(fs, hostCodexHome, {
    chatgptBaseUrl: deps.chatgptBaseUrl
  });
  try {
    fs.writeFileSync(path.join(runtimeHome, 'config.toml'), runtimeConfig, 'utf8');
  } catch (_error) {
    return null;
  }
  if (!writeJsonFilePrivate(fs, path.join(runtimeHome, 'auth.json'), runtimeAuth)) {
    return null;
  }

  return {
    runtimeHome,
    hostCodexHome,
    accountId: identity.id,
    authType: identity.authType,
    env: {
      CODEX_HOME: runtimeHome,
      CODEX_SQLITE_HOME: hostCodexHome
    }
  };
}

function buildCodexAppServerSpawnEnv(fs, state, deps = {}) {
  const processObj = deps.processObj || process;
  const env = {
    ...((processObj && processObj.env) || process.env)
  };
  const runtime = prepareCodexAppServerRuntimeHome(fs, state, deps);
  if (!runtime) return { env, runtime: null };
  const nextEnv = {
    ...env,
    ...runtime.env
  };
  if (runtime.authType === CODEX_DESKTOP_AUTH_TYPES.CHATGPT) {
    delete nextEnv.OPENAI_API_KEY;
    delete nextEnv.OPENAI_BASE_URL;
  }
  return {
    env: nextEnv,
    runtime
  };
}

function startRemoteControlProxyProcess(fs, state, writeTrace, deps = {}) {
  if (!state || state.remoteControlProxy !== true) return null;
  const processObj = deps.processObj || process;
  const nodeExecPath = String(processObj.execPath || process.execPath || '').trim();
  if (!nodeExecPath) return null;
  const readyFile = path.join(
    os.tmpdir(),
    `aih-codex-remote-control-proxy-${processObj.pid || process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  const suppressStateFile = path.join(
    os.tmpdir(),
    `aih-codex-remote-control-suppress-${processObj.pid || process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  writeJsonFilePrivate(fs, suppressStateFile, { threads: [] });
  const args = [
    require.resolve('./codex-remote-control-proxy'),
    '--host', '127.0.0.1',
    '--port', '0',
    '--ready-file', readyFile,
    '--suppress-state-file', suppressStateFile,
    '--parent-pid', String(processObj.pid || process.pid || 0)
  ];
  if (state.traceFile) {
    args.push('--trace-file', state.traceFile);
  }
  let child = null;
  try {
    child = childProcess.spawn(nodeExecPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: processObj.env || process.env,
      detached: false
    });
  } catch (error) {
    cleanupTemporaryFiles(fs, [suppressStateFile]);
    writeTrace({
      direction: 'proxy_internal',
      action: 'remote_control_proxy_spawn_failed',
      error: sanitizeTraceText(error && error.message || error)
    });
    return null;
  }
  if (child.stderr && typeof child.stderr.on === 'function') {
    const stderrPump = createLinePump((line) => {
      if (!line) return;
      writeTrace({
        direction: 'remote_control_proxy_stderr',
        remoteControl: true,
        line: sanitizeTraceText(line)
      });
    });
    child.stderr.on('data', (chunk) => stderrPump.write(chunk));
    child.stderr.on('end', () => stderrPump.flush());
  }
  const ready = waitForReadyFile(fs, readyFile);
  if (typeof fs.rmSync === 'function') {
    try { fs.rmSync(readyFile, { force: true }); } catch (_error) {}
  }
  if (!ready || ready.ok !== true || !Number.isFinite(Number(ready.port))) {
    try { child.kill('SIGTERM'); } catch (_error) {}
    cleanupTemporaryFiles(fs, [suppressStateFile]);
    writeTrace({
      direction: 'proxy_internal',
      action: 'remote_control_proxy_not_ready',
      error: sanitizeTraceText(ready && ready.error || 'timeout')
    });
    return null;
  }
  const baseUrl = `http://127.0.0.1:${Number(ready.port)}/backend-api`;
  writeTrace({
    direction: 'proxy_internal',
    action: 'remote_control_proxy_ready',
    baseUrl
  });
  return {
    child,
    baseUrl,
    suppressStateFile
  };
}

function writeRemoteHydrationSuppressionState(fs, filePath, pendingHydrationsByThreadId, nowMs = Date.now()) {
  const stateFile = String(filePath || '').trim();
  if (!stateFile) return;
  const threads = [];
  for (const [threadId, pendingHydration] of pendingHydrationsByThreadId && pendingHydrationsByThreadId.entries
    ? pendingHydrationsByThreadId.entries()
    : []) {
    const expiresAt = Number(pendingHydration && pendingHydration.remoteSuppressExpiresAtMs);
    if (String(threadId || '').trim() && Number.isFinite(expiresAt) && expiresAt > nowMs) {
      threads.push({ id: String(threadId), expiresAt });
    }
  }
  writeJsonFilePrivate(fs, stateFile, { threads });
}

function listCodexStateDbPaths(fs, codexHome) {
  try {
    return fs.readdirSync(codexHome)
      .filter((entryName) => /^state_\d+\.sqlite$/i.test(entryName))
      .map((entryName) => path.join(codexHome, entryName))
      .sort((left, right) => {
        const leftVersion = Number((path.basename(left).match(/^state_(\d+)\.sqlite$/i) || [])[1]) || 0;
        const rightVersion = Number((path.basename(right).match(/^state_(\d+)\.sqlite$/i) || [])[1]) || 0;
        return rightVersion - leftVersion;
      });
  } catch (_error) {
    return [];
  }
}

function getSqliteTableColumns(db, tableName) {
  try {
    return new Set(
      db.prepare(`PRAGMA table_info(${tableName})`).all()
        .map((row) => String(row && row.name || '').trim())
        .filter(Boolean)
    );
  } catch (_error) {
    return new Set();
  }
}

function getThreadRequestId(payload) {
  const params = payload && payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? payload.params
    : {};
  return String(params.threadId || params.thread_id || params.id || '').trim();
}

function getThreadGoalRequestContext(payload) {
  if (!payload || payload.method !== 'thread/goal/get') return null;
  const threadId = getThreadRequestId(payload);
  if (!threadId) return null;
  return { threadId };
}

function getThreadListRequestContext(payload) {
  if (!payload || payload.method !== 'thread/list') return null;
  const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? payload.params
    : {};
  return {
    cwd: String(params.cwd || '').trim(),
    archived: params.archived === true,
    sourceKinds: Array.isArray(params.sourceKinds) ? params.sourceKinds.slice() : [],
    modelProviders: Array.isArray(params.modelProviders) ? params.modelProviders.slice() : [],
    limit: Number(params.limit),
    cursor: Object.prototype.hasOwnProperty.call(params, 'cursor') && params.cursor !== null
      ? String(params.cursor || '')
      : null,
    sortKey: String(params.sortKey || '').trim(),
    useStateDbOnly: params.useStateDbOnly === true
  };
}

function resolveCodexHome(deps = {}) {
  const processObj = deps.processObj || process;
  const env = processObj.env || {};
  const explicitCodexHome = String(env.CODEX_HOME || '').trim();
  if (explicitCodexHome) return decodeEncodedWindowsPath(explicitCodexHome);
  const hostHome = resolveHostHomeDir({
    env,
    platform: processObj.platform,
    os: deps.os
  });
  return hostHome ? path.join(hostHome, '.codex') : '';
}

function resolveCodexStateHome(deps = {}) {
  const processObj = deps.processObj || process;
  const env = processObj.env || {};
  const sqliteHome = String(env.CODEX_SQLITE_HOME || '').trim();
  if (sqliteHome) return decodeEncodedWindowsPath(sqliteHome);
  const codexHome = resolveCodexHome(deps);
  const normalizedCodexHome = codexHome.replace(/\\/g, '/');
  if (normalizedCodexHome.includes('/.ai_home/codex-desktop-runtime/app-server-')) {
    const hostCodexHome = resolveHostCodexHome(deps);
    if (hostCodexHome) return hostCodexHome;
  }
  return codexHome;
}

function hasArg(args, name) {
  return (Array.isArray(args) ? args : []).some((arg) => String(arg || '').trim() === name);
}

function runCodexResumeVisibilityRepair(argv, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const processObj = deps.processObj || process;
  const parsed = parseProxyArgs(argv);
  const state = readHookState(fs, parsed.stateFile);
  if (!state.enabled) return { ok: true, skipped: true, reason: 'hook_disabled' };
  const args = Array.isArray(parsed.forwardArgs) ? parsed.forwardArgs : [];
  if (String(args[0] || '').trim() !== 'resume') {
    return { ok: true, skipped: true, reason: 'not_resume' };
  }

  const codexHome = resolveCodexStateHome({ ...deps, processObj });
  if (!codexHome) return { ok: true, skipped: true, reason: 'missing_codex_home' };
  const runtimeConfig = readCurrentCodexRuntimeConfig(fs, codexHome, { ...deps, processObj });
  const showAll = hasArg(args, '--all');
  const includeNonInteractive = hasArg(args, '--include-non-interactive');
  return repairCodexSessionVisibility(codexHome, {
    fs,
    path,
    cwd: showAll ? '' : processObj.cwd(),
    includeNonInteractive,
    currentModelProvider: runtimeConfig.modelProvider,
    DatabaseSync: deps.DatabaseSync || getDatabaseSyncCtor()
  });
}

function isAihRolloutSidecarPath(filePath) {
  const normalizedPath = String(filePath || '').trim();
  return normalizedPath.includes('.aih-slim-') || normalizedPath.includes('.aih-full-');
}

function deriveOriginalRolloutPathFromSidecar(filePath) {
  const normalizedPath = String(filePath || '').trim();
  if (!normalizedPath) return '';
  const slimIndex = normalizedPath.indexOf('.aih-slim-');
  if (slimIndex > 0) return normalizedPath.slice(0, slimIndex);
  const fullIndex = normalizedPath.indexOf('.aih-full-');
  if (fullIndex > 0) return normalizedPath.slice(0, fullIndex);
  return '';
}

function isExistingCanonicalRolloutFile(fs, threadId, filePath) {
  const id = String(threadId || '').trim();
  const candidate = String(filePath || '').trim();
  if (!id || !candidate) return false;
  if (!candidate.endsWith('.jsonl') || isAihRolloutSidecarPath(candidate)) return false;
  if (!path.basename(candidate).includes(id)) return false;
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  } catch (_error) {
    return false;
  }
}

function findCanonicalRolloutPathByThreadId(fs, codexHome, threadId) {
  const id = String(threadId || '').trim();
  const sessionsDir = path.join(String(codexHome || '').trim(), 'sessions');
  if (!id || !sessionsDir) return '';
  try {
    if (!fs.existsSync(sessionsDir) || !fs.statSync(sessionsDir).isDirectory()) return '';
  } catch (_error) {
    return '';
  }

  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (
        entry.name.startsWith('rollout-')
        && entry.name.endsWith(`${id}.jsonl`)
        && !isAihRolloutSidecarPath(entry.name)
      ) {
        return fullPath;
      }
    }
  }
  return '';
}

function resolveCanonicalRolloutPath(fs, codexHome, threadId, rolloutPath) {
  const id = String(threadId || '').trim();
  const currentPath = String(rolloutPath || '').trim();
  if (!id || !currentPath) return '';

  const derivedPath = deriveOriginalRolloutPathFromSidecar(currentPath);
  if (isExistingCanonicalRolloutFile(fs, id, derivedPath)) {
    return derivedPath;
  }

  return findCanonicalRolloutPathByThreadId(fs, codexHome, id);
}

function isSyntheticThreadTitle(text) {
  const title = String(text || '').replace(/\s+/g, ' ').trim();
  return title.startsWith('# AGENTS.md instructions')
    || title.startsWith('<codex_internal_context')
    || title.startsWith('<environment_context')
    || title.startsWith('<turn_aborted')
    || title.startsWith('<user_instructions')
    || title.startsWith('<user_shell_command')
    || title.includes('<INSTRUCTIONS>');
}

function extractObjectiveTitleFromText(text) {
  const match = String(text || '').match(/<objective>\s*([\s\S]*?)\s*<\/objective>/i);
  return match ? sanitizeThreadTitleForRepair(match[1]) : '';
}

function extractThreadTitleFromUserText(text) {
  return extractObjectiveTitleFromText(text) || sanitizeThreadTitleForRepair(text);
}

function sanitizeThreadTitleForRepair(text) {
  const title = String(text || '').replace(/\s+/g, ' ').trim();
  if (!title) return '';
  if (isSyntheticThreadTitle(title)) return '';
  if (title.startsWith('Caveat:') || title.startsWith('<command-name>') || title.startsWith('<local-command')) {
    return '';
  }
  return title.slice(0, 4000);
}

function shouldRepairThreadTitleValue(text) {
  const title = String(text || '').trim();
  return !title || isSyntheticThreadTitle(title);
}

function extractThreadTitleFromCodexPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';

  if (payload.type === 'user_message') {
    return extractThreadTitleFromUserText(payload.message);
  }

  if (payload.type === 'thread_goal_updated' && payload.goal && typeof payload.goal === 'object') {
    return sanitizeThreadTitleForRepair(payload.goal.objective);
  }

  if (payload.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)) {
    const text = payload.content
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        if (block.type === 'input_text') return String(block.text || '');
        if (block.type === 'text') return String(block.text || '');
        return '';
      })
      .filter(Boolean)
      .join(' ');
    return extractThreadTitleFromUserText(text);
  }

  return '';
}

function extractThreadTitleFromRolloutLine(line) {
  const text = String(line || '');
  if (
    !text.includes('user_message')
    && !/"role"\s*:\s*"user"/.test(text)
    && !text.includes('thread_goal_updated')
  ) {
    return '';
  }
  try {
    const entry = JSON.parse(text);
    if (!entry || (entry.type !== 'event_msg' && entry.type !== 'response_item')) return '';
    return extractThreadTitleFromCodexPayload(entry && entry.payload);
  } catch (_error) {
    return '';
  }
}

function readThreadTitleFromSessionIndex(fs, codexHome, threadId) {
  const id = String(threadId || '').trim();
  const indexPath = path.join(String(codexHome || '').trim(), 'session_index.jsonl');
  if (!id || !indexPath) return '';
  try {
    if (!fs.existsSync(indexPath) || !fs.statSync(indexPath).isFile()) return '';
    const lines = String(fs.readFileSync(indexPath, 'utf8') || '').split(/\r?\n/);
    for (const line of lines) {
      if (!line || !line.includes(id)) continue;
      try {
        const entry = JSON.parse(line);
        if (String(entry && entry.id || '').trim() !== id) continue;
        const title = sanitizeThreadTitleForRepair(entry.thread_name);
        if (title) return title;
      } catch (_parseError) {
        continue;
      }
    }
  } catch (_error) {
    return '';
  }
  return '';
}

function readThreadTitleFromRolloutFile(fs, rolloutPath, options = {}) {
  const filePath = String(rolloutPath || '').trim();
  if (!filePath) return '';
  const maxBytes = Math.max(1024, Number(options.maxBytes) || THREAD_TITLE_REPAIR_MAX_BYTES);
  const chunkSize = 64 * 1024;
  const maxCarryChars = 8 * 1024 * 1024;
  let fd = null;
  let carry = '';
  let bytesReadTotal = 0;

  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return '';
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(chunkSize);
    while (bytesReadTotal < maxBytes) {
      const bytesToRead = Math.min(chunkSize, maxBytes - bytesReadTotal);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, null);
      if (bytesRead <= 0) break;
      bytesReadTotal += bytesRead;
      carry += buffer.toString('utf8', 0, bytesRead);

      let newlineIndex = carry.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = carry.slice(0, newlineIndex).replace(/\r$/, '');
        carry = carry.slice(newlineIndex + 1);
        const title = extractThreadTitleFromRolloutLine(line);
        if (title) return title;
        newlineIndex = carry.indexOf('\n');
      }

      if (carry.length > maxCarryChars) {
        const title = extractThreadTitleFromRolloutLine(carry);
        if (title) return title;
        carry = '';
      }
    }

    return extractThreadTitleFromRolloutLine(carry);
  } catch (_error) {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_closeError) {}
    }
  }
}

function buildMissingThreadTitleSelect(columns) {
  if (!columns.has('id') || !columns.has('rollout_path') || !columns.has('title')) return '';
  const firstUserExpr = columns.has('first_user_message') ? 'first_user_message' : 'NULL AS first_user_message';
  const previewExpr = columns.has('preview') ? 'preview' : 'NULL AS preview';
  const archivedClause = columns.has('archived') ? 'AND archived = 0' : '';
  const orderExpr = columns.has('updated_at_ms') && columns.has('updated_at')
    ? 'COALESCE(updated_at_ms, updated_at * 1000)'
    : columns.has('updated_at_ms')
      ? 'updated_at_ms'
      : columns.has('updated_at')
        ? 'updated_at * 1000'
        : columns.has('created_at_ms') && columns.has('created_at')
          ? 'COALESCE(created_at_ms, created_at * 1000)'
          : columns.has('created_at_ms')
            ? 'created_at_ms'
            : columns.has('created_at')
              ? 'created_at * 1000'
              : 'id';
  return `
    SELECT id, rollout_path, title, ${firstUserExpr}, ${previewExpr}
    FROM threads
    WHERE (
        title IS NULL
        OR TRIM(title) = ''
        OR title LIKE '# AGENTS.md instructions%'
        OR title LIKE '<environment_context%'
        OR title LIKE '<user_instructions%'
        OR title LIKE '<user_shell_command%'
        OR title LIKE '%<INSTRUCTIONS>%'
      )
      AND rollout_path IS NOT NULL
      AND TRIM(rollout_path) != ''
      ${archivedClause}
    ORDER BY ${orderExpr} DESC
    LIMIT ?
  `;
}

function repairMissingThreadTitleFields(deps = {}) {
  const fs = deps.fs || require('node:fs');
  const codexHome = String(deps.codexHome || resolveCodexStateHome(deps)).trim();
  const DatabaseSync = deps.DatabaseSync || getDatabaseSyncCtor();
  const limit = Math.max(1, Number(deps.limit) || THREAD_TITLE_REPAIR_LIMIT);
  const summary = {
    checked: 0,
    repaired: 0,
    failed: 0,
    items: []
  };
  if (!DatabaseSync || !codexHome) return summary;

  for (const stateDbPath of listCodexStateDbPaths(fs, codexHome)) {
    let db = null;
    try {
      db = new DatabaseSync(stateDbPath);
      db.exec('PRAGMA busy_timeout = 1000;');
      const columns = getSqliteTableColumns(db, 'threads');
      const query = buildMissingThreadTitleSelect(columns);
      if (!query) continue;
      const rows = db.prepare(query).all(limit);
      for (const row of rows) {
        const threadId = String(row && row.id || '').trim();
        const rolloutPath = String(row && row.rollout_path || '').trim();
        if (!threadId || !rolloutPath) continue;
        summary.checked += 1;

        const title = readThreadTitleFromSessionIndex(fs, codexHome, threadId)
          || sanitizeThreadTitleForRepair(row.first_user_message || row.preview)
          || readThreadTitleFromRolloutFile(fs, rolloutPath, deps);
        if (!title) {
          summary.failed += 1;
          continue;
        }

        const assignments = [];
        const values = [];
        for (const columnName of ['title', 'first_user_message', 'preview']) {
          if (!columns.has(columnName)) continue;
          if (!shouldRepairThreadTitleValue(row[columnName])) continue;
          assignments.push(`${columnName} = ?`);
          values.push(title);
        }
        if (assignments.length === 0) continue;
        values.push(threadId);
        const result = db.prepare(`UPDATE threads SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
        const changed = Number(result && result.changes) || 0;
        if (changed > 0) {
          summary.repaired += 1;
          summary.items.push({ threadId, title });
        }
      }
    } catch (_error) {
      continue;
    } finally {
      if (db && typeof db.close === 'function') {
        try { db.close(); } catch (_closeError) {}
      }
    }
  }

  return summary;
}

function repairThreadRolloutPathIfNeeded(db, row, codexHome, fs) {
  const threadId = String(row && row.id || '').trim();
  const rolloutPath = String(row && row.rollout_path || '').trim();
  if (!threadId || !rolloutPath || !isAihRolloutSidecarPath(rolloutPath)) {
    return { checked: Boolean(threadId), repaired: false };
  }

  const canonicalPath = resolveCanonicalRolloutPath(fs, codexHome, threadId, rolloutPath);
  if (!canonicalPath) {
    return { checked: true, repaired: false, reason: 'canonical_missing' };
  }

  try {
    db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?')
      .run(canonicalPath, threadId, rolloutPath);
    row.rollout_path = canonicalPath;
    return {
      checked: true,
      repaired: true,
      threadId,
      previousPath: rolloutPath,
      repairedPath: canonicalPath
    };
  } catch (error) {
    return {
      checked: true,
      repaired: false,
      threadId,
      reason: String(error && error.message || error || 'update_failed')
    };
  }
}

function restoreOptimizedRolloutPathInStateDbs(restore, deps = {}) {
  const threadId = String(restore && restore.threadId || '').trim();
  const optimizedPath = String(restore && restore.optimizedPath || '').trim();
  const originalPath = String(restore && restore.originalPath || '').trim();
  if (!threadId || !optimizedPath || !originalPath) return { checked: 0, repaired: 0 };

  const fs = deps.fs || require('node:fs');
  if (!isExistingCanonicalRolloutFile(fs, threadId, originalPath)) {
    return { checked: 0, repaired: 0, reason: 'original_missing' };
  }

  const DatabaseSync = deps.DatabaseSync || getDatabaseSyncCtor();
  const codexHome = String(deps.codexHome || resolveCodexStateHome(deps)).trim();
  if (!DatabaseSync || !codexHome) return { checked: 0, repaired: 0 };

  let checked = 0;
  let repaired = 0;
  for (const stateDbPath of listCodexStateDbPaths(fs, codexHome)) {
    let db = null;
    try {
      db = new DatabaseSync(stateDbPath);
      db.exec('PRAGMA busy_timeout = 1000;');
      checked += 1;
      const result = db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?')
        .run(originalPath, threadId, optimizedPath);
      repaired += Number(result && result.changes) || 0;
    } catch (_error) {
      continue;
    } finally {
      if (db && typeof db.close === 'function') {
        try { db.close(); } catch (_closeError) {}
      }
    }
  }

  return { checked, repaired, threadId, optimizedPath, originalPath };
}

function repairMissingOptimizedRolloutPaths(deps = {}) {
  const fs = deps.fs || require('node:fs');
  const codexHome = String(deps.codexHome || resolveCodexStateHome(deps)).trim();
  const DatabaseSync = deps.DatabaseSync || getDatabaseSyncCtor();
  const limit = Math.max(1, Number(deps.limit) || 200);
  const summary = {
    checked: 0,
    repaired: 0,
    failed: 0,
    items: []
  };
  if (!DatabaseSync || !codexHome) return summary;

  for (const stateDbPath of listCodexStateDbPaths(fs, codexHome)) {
    let db = null;
    try {
      db = new DatabaseSync(stateDbPath);
      db.exec('PRAGMA busy_timeout = 1000;');
      const rows = db.prepare(`
        SELECT id, rollout_path
        FROM threads
        WHERE rollout_path LIKE '%.aih-slim-%' OR rollout_path LIKE '%.aih-full-%'
        LIMIT ?
      `).all(limit);
      for (const row of rows) {
        const result = repairThreadRolloutPathIfNeeded(db, row, codexHome, fs);
        summary.checked += result.checked ? 1 : 0;
        if (result.repaired) {
          summary.repaired += 1;
          summary.items.push(result);
        } else if (result.reason) {
          summary.failed += 1;
        }
      }
    } catch (_error) {
      continue;
    } finally {
      if (db && typeof db.close === 'function') {
        try { db.close(); } catch (_closeError) {}
      }
    }
  }

  return summary;
}

function getThreadStateRow(db, threadId) {
  return db.prepare(`
    SELECT
      id,
      rollout_path,
      created_at,
      updated_at,
      created_at_ms,
      updated_at_ms,
      source,
      model_provider,
      model,
      cwd,
      title,
      sandbox_policy,
      approval_mode,
      cli_version,
      first_user_message,
      agent_nickname,
      agent_role,
      git_sha,
      git_branch,
      git_origin_url,
      reasoning_effort,
      thread_source
    FROM threads
    WHERE id = ?
  `).get(threadId);
}

function findThreadStateRow(threadId, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const codexHome = String(deps.codexHome || resolveCodexStateHome(deps)).trim();
  if (!codexHome) return null;
  const DatabaseSync = deps.DatabaseSync || getDatabaseSyncCtor();
  if (!DatabaseSync) return null;

  for (const stateDbPath of listCodexStateDbPaths(fs, codexHome)) {
    let db = null;
    try {
      db = new DatabaseSync(stateDbPath);
      db.exec('PRAGMA busy_timeout = 1000;');
      const row = getThreadStateRow(db, threadId);
      if (row) {
        const rolloutRepair = repairThreadRolloutPathIfNeeded(db, row, codexHome, fs);
        return { row, stateDbPath, rolloutRepair };
      }
    } catch (_error) {
      continue;
    } finally {
      if (db && typeof db.close === 'function') {
        try { db.close(); } catch (_closeError) {}
      }
    }
  }
  return null;
}

function normalizeThreadListSourceKinds(sourceKinds) {
  return new Set(
    (Array.isArray(sourceKinds) ? sourceKinds : [])
      .map((sourceKind) => String(sourceKind || '').trim())
      .filter(Boolean)
  );
}

function addSqlInFilter(whereParts, bindings, columnName, values) {
  const filtered = Array.from(values || [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (filtered.length === 0) return;
  whereParts.push(`${columnName} IN (${filtered.map(() => '?').join(', ')})`);
  bindings.push(...filtered);
}

function buildThreadListStateQuery(columns, filters = {}) {
  if (!columns.has('id') || !columns.has('cwd') || !columns.has('title')) return '';

  const whereParts = [];
  const bindings = [];
  if (columns.has('archived')) {
    whereParts.push('COALESCE(archived, 0) = ?');
    bindings.push(filters.archived ? 1 : 0);
  }
  const cwdFilter = String(filters.cwd || '').trim();
  if (cwdFilter && columns.has('cwd')) {
    whereParts.push('cwd = ?');
    bindings.push(cwdFilter);
  }
  if (columns.has('source')) {
    addSqlInFilter(whereParts, bindings, 'source', filters.sourceKinds);
  }
  if (columns.has('model_provider')) {
    addSqlInFilter(whereParts, bindings, 'model_provider', filters.modelProviders);
  }

  const updatedAtMsExpr = columns.has('updated_at_ms') ? 'updated_at_ms' : 'NULL AS updated_at_ms';
  const updatedAtExpr = columns.has('updated_at') ? 'updated_at' : 'NULL AS updated_at';
  const createdAtMsExpr = columns.has('created_at_ms') ? 'created_at_ms' : 'NULL AS created_at_ms';
  const createdAtExpr = columns.has('created_at') ? 'created_at' : 'NULL AS created_at';
  const rolloutPathExpr = columns.has('rollout_path') ? 'rollout_path' : 'NULL AS rollout_path';
  const firstUserMessageExpr = columns.has('first_user_message') ? 'first_user_message' : 'NULL AS first_user_message';
  const sourceExpr = columns.has('source') ? 'source' : 'NULL AS source';
  const modelProviderExpr = columns.has('model_provider') ? 'model_provider' : 'NULL AS model_provider';
  const modelExpr = columns.has('model') ? 'model' : 'NULL AS model';
  const cliVersionExpr = columns.has('cli_version') ? 'cli_version' : 'NULL AS cli_version';
  const archivedExpr = columns.has('archived') ? 'archived' : '0 AS archived';
  const gitShaExpr = columns.has('git_sha') ? 'git_sha' : 'NULL AS git_sha';
  const gitBranchExpr = columns.has('git_branch') ? 'git_branch' : 'NULL AS git_branch';
  const gitOriginUrlExpr = columns.has('git_origin_url') ? 'git_origin_url' : 'NULL AS git_origin_url';
  const reasoningEffortExpr = columns.has('reasoning_effort') ? 'reasoning_effort' : 'NULL AS reasoning_effort';
  const threadSourceExpr = columns.has('thread_source') ? 'thread_source' : 'NULL AS thread_source';
  const orderExpr = columns.has('updated_at_ms') && columns.has('updated_at')
    ? 'COALESCE(updated_at_ms, updated_at * 1000)'
    : columns.has('updated_at_ms')
      ? 'updated_at_ms'
      : columns.has('updated_at')
        ? 'updated_at * 1000'
        : columns.has('created_at_ms') && columns.has('created_at')
          ? 'COALESCE(created_at_ms, created_at * 1000)'
          : columns.has('created_at_ms')
            ? 'created_at_ms'
            : columns.has('created_at')
              ? 'created_at * 1000'
              : 'id';

  const sql = `
    SELECT id, cwd, title, ${updatedAtExpr}, ${updatedAtMsExpr}, ${createdAtExpr}, ${createdAtMsExpr}, ${rolloutPathExpr}, ${firstUserMessageExpr},
      ${sourceExpr}, ${modelProviderExpr}, ${modelExpr}, ${cliVersionExpr}, ${archivedExpr}, ${gitShaExpr}, ${gitBranchExpr}, ${gitOriginUrlExpr},
      ${reasoningEffortExpr}, ${threadSourceExpr}
    FROM threads
    ${whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''}
    ORDER BY ${orderExpr} DESC, id DESC
    LIMIT ?
  `;
  return {
    sql,
    bindings
  };
}

function readThreadListFromStateDb(fs, codexHome, params = {}, deps = {}) {
  const DatabaseSync = deps.DatabaseSync || getDatabaseSyncCtor();
  if (!DatabaseSync || !codexHome) return [];

  const requestLimit = Number(params.limit);
  const limit = Math.max(
    1,
    Number.isFinite(requestLimit) && requestLimit > 0 ? Math.min(Math.floor(requestLimit), AGGREGATE_THREAD_LIST_MAX_ITEMS) : AGGREGATE_THREAD_LIST_MAX_ITEMS
  );
  const sourceKinds = normalizeThreadListSourceKinds(params.sourceKinds);
  const modelProviders = new Set(
    (Array.isArray(params.modelProviders) ? params.modelProviders : [])
      .map((modelProvider) => String(modelProvider || '').trim())
      .filter(Boolean)
  );
  const cwdFilter = String(params.cwd || '').trim();
  const isArchived = params.archived === true;
  const rows = [];
  const seen = new Set();
  const scanLimit = Math.max(limit * 4, 200);

  for (const stateDbPath of listCodexStateDbPaths(fs, codexHome)) {
    let db = null;
    try {
      db = new DatabaseSync(stateDbPath);
      db.exec('PRAGMA busy_timeout = 1000;');
      const query = buildThreadListStateQuery(getSqliteTableColumns(db, 'threads'), {
        archived: isArchived,
        cwd: cwdFilter,
        sourceKinds,
        modelProviders
      });
      if (!query || !query.sql) continue;
      const dbRows = db.prepare(query.sql).all(...query.bindings, scanLimit);
      for (const row of dbRows) {
        const threadId = String(row && row.id || '').trim();
        if (!threadId || seen.has(threadId)) continue;
        const rowCwd = String(row && row.cwd || '').trim();
        if (!rowCwd) continue;
        if (cwdFilter && rowCwd !== cwdFilter) continue;
        if (!isArchived && Number(row && row.archived) === 1) continue;
        const rowSource = String(row && row.source || '').trim();
        if (sourceKinds.size > 0 && !sourceKinds.has(rowSource)) continue;
        const rowModelProvider = String(row && row.model_provider || '').trim();
        if (modelProviders.size > 0 && !modelProviders.has(rowModelProvider)) continue;
        const title = String(row && row.title || row && row.first_user_message || '').trim()
          || readThreadTitleFromSessionIndex(fs, codexHome, threadId)
          || (row && row.rollout_path ? readThreadTitleFromRolloutFile(fs, row.rollout_path, deps) : '');
        if (!title || title === 'Warmup' || title === '未命名会话') continue;
        seen.add(threadId);
        rows.push({
          ...row,
          title
        });
        if (rows.length >= limit) return rows;
      }
    } catch (_error) {
      continue;
    } finally {
      if (db && typeof db.close === 'function') {
        try { db.close(); } catch (_closeError) {}
      }
    }
  }

  return rows;
}

function buildThreadListStateThreads(params = {}, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const codexHome = String(deps.codexHome || resolveCodexStateHome(deps)).trim();
  if (!codexHome) return [];
  const rows = readThreadListFromStateDb(fs, codexHome, params, deps);
  return rows
    .map((row) => {
      const thread = buildThreadFromStateRow(row, [], {
        status: { type: 'notLoaded' }
      });
      if (!thread || !thread.id) return null;
      return thread;
    })
    .filter(Boolean);
}

function patchThreadListVisibilityResponse(line, context = {}, options = {}) {
  if (!context || typeof context !== 'object') return line;
  const parsed = tryParseJson(line);
  if (!parsed || !parsed.result || typeof parsed.result !== 'object' || Array.isArray(parsed.result)) return line;
  const upstreamData = Array.isArray(parsed.result.data) ? parsed.result.data : [];
  const stateThreads = buildThreadListStateThreads(context, options);
  if (stateThreads.length === 0) return line;
  const mergedData = mergeThreadListData(upstreamData, stateThreads);
  const requestedLimit = Number(context.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.max(requestedLimit, upstreamData.length, stateThreads.length)
    : Math.max(upstreamData.length, stateThreads.length);
  const cappedData = mergedData
    .slice()
    .sort((left, right) => {
      const leftUpdatedAt = Number(left && left.updatedAt) || 0;
      const rightUpdatedAt = Number(right && right.updatedAt) || 0;
      if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
      return String(right && right.id || '').localeCompare(String(left && left.id || ''));
    })
    .slice(0, Math.max(1, Math.min(limit || mergedData.length || 1, AGGREGATE_THREAD_LIST_MAX_ITEMS)));
  const upstreamIds = upstreamData.map((item) => getThreadObjectId(item));
  const cappedIds = cappedData.map((item) => getThreadObjectId(item));
  if (
    cappedIds.length === upstreamIds.length
    && cappedIds.every((id, index) => id === upstreamIds[index])
  ) {
    return line;
  }
  return JSON.stringify({
    ...parsed,
    result: {
      ...parsed.result,
      data: cappedData
    }
  });
}

function reconcileSelectedThreadConfig(payload, deps = {}) {
  if (!payload || (payload.method !== 'thread/resume' && payload.method !== 'thread/read')) return null;
  const threadId = getThreadRequestId(payload);
  if (!threadId) return null;

  const fs = deps.fs || require('node:fs');
  const codexHome = resolveCodexStateHome(deps);
  if (!codexHome) return null;

  const currentConfig = readCurrentCodexRuntimeConfig(fs, codexHome, deps);
  const currentProvider = currentConfig.modelProvider;
  const currentModel = currentConfig.model;
  if (!isAihManagedProvider(currentProvider)) return null;

  const DatabaseSync = deps.DatabaseSync || getDatabaseSyncCtor();
  if (!DatabaseSync) return null;

  for (const stateDbPath of listCodexStateDbPaths(fs, codexHome)) {
    let db = null;
    try {
      db = new DatabaseSync(stateDbPath);
      db.exec('PRAGMA busy_timeout = 1000;');
      const row = db.prepare('SELECT model_provider, model FROM threads WHERE id = ?').get(threadId);
      const persistedProvider = String(row && row.model_provider || '').trim();
      const persistedModel = String(row && row.model || '').trim();
      if (!row || !persistedProvider) {
        return {
          changed: false,
          method: payload.method,
          threadId,
          stateDbPath,
          persistedProvider,
          persistedModel,
          currentProvider
        };
      }
      const shouldRewriteProvider = persistedProvider !== currentProvider;
      const shouldRewriteModel = currentModel && persistedModel !== currentModel;
      return {
        changed: shouldRewriteProvider || shouldRewriteModel,
        method: payload.method,
        threadId,
        stateDbPath,
        persistedProvider,
        persistedModel,
        currentProvider,
        currentModel
      };
    } catch (_error) {
      continue;
    } finally {
      if (db && typeof db.close === 'function') {
        try { db.close(); } catch (_closeError) {}
      }
    }
  }

  return null;
}

function reconcileResumeThreadProvider(payload, deps = {}) {
  if (!payload || payload.method !== 'thread/resume') return null;
  return reconcileSelectedThreadConfig(payload, deps);
}

function rewriteThreadResumeRuntimeConfig(payload, reconcileResult) {
  if (!payload || payload.method !== 'thread/resume' || !reconcileResult) return payload;
  const currentProvider = String(reconcileResult.currentProvider || '').trim();
  const currentModel = String(reconcileResult.currentModel || '').trim();
  if (!currentProvider && !currentModel) return payload;
  const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? { ...payload.params }
    : {};
  let changed = false;
  if (currentProvider && params.modelProvider !== currentProvider) {
    params.modelProvider = currentProvider;
    changed = true;
  }
  if (currentModel && params.model !== currentModel) {
    params.model = currentModel;
    changed = true;
  }
  return changed ? { ...payload, params } : payload;
}

function buildFastResumeHydrationRequest(payload, reconcileResult, sequence = 1) {
  if (!payload || payload.method !== 'thread/resume') return null;
  const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? { ...payload.params }
    : {};
  const threadId = getThreadRequestId(payload);
  if (!threadId) return null;
  params.excludeTurns = true;
  const currentProvider = String(reconcileResult && reconcileResult.currentProvider || '').trim();
  const currentModel = String(reconcileResult && reconcileResult.currentModel || '').trim();
  if (currentProvider) params.modelProvider = currentProvider;
  if (currentModel) params.model = currentModel;
  return {
    ...payload,
    id: `aih-hydrate-thread-resume:${String(payload.id || threadId)}:${sequence}`,
    params
  };
}

function shouldHydrateLiveThreadTurnPayload(payload) {
  return Boolean(payload && LIVE_THREAD_TURN_METHODS.has(payload.method));
}

function buildTurnLiveThreadHydrationRequest(payload, reconcileResult, sequence = 1) {
  if (!shouldHydrateLiveThreadTurnPayload(payload)) return null;
  const threadId = getThreadRequestId(payload);
  if (!threadId) return null;
  const currentProvider = String(reconcileResult && reconcileResult.currentProvider || '').trim();
  const currentModel = String(reconcileResult && reconcileResult.currentModel || '').trim();
  const params = {
    threadId,
    excludeTurns: true
  };
  if (currentProvider) params.modelProvider = currentProvider;
  if (currentModel) params.model = currentModel;
  const methodLabel = String(payload.method || '').replace(/[^A-Za-z0-9]+/g, '-');
  return {
    id: `aih-hydrate-${methodLabel}:${String(payload.id || threadId)}:${sequence}`,
    method: 'thread/resume',
    params
  };
}

function buildTurnStartHydrationRequest(payload, reconcileResult, sequence = 1) {
  return buildTurnLiveThreadHydrationRequest(payload, reconcileResult, sequence);
}

function getHydrationNotificationThreadId(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  if (Object.prototype.hasOwnProperty.call(payload, 'id')) return '';
  const method = String(payload.method || '').trim();
  if (!HYDRATION_NOTIFICATION_METHODS.has(method)) return '';
  const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? payload.params
    : {};
  if (method === 'thread/started') {
    const thread = params.thread && typeof params.thread === 'object' && !Array.isArray(params.thread)
      ? params.thread
      : {};
    return String(thread.id || '').trim();
  }
  return String(params.threadId || params.thread_id || '').trim();
}

function shouldSuppressHydrationNotification(payload, pendingHydrationsByThreadId) {
  if (!pendingHydrationsByThreadId || typeof pendingHydrationsByThreadId.has !== 'function') {
    return false;
  }
  const threadId = getHydrationNotificationThreadId(payload);
  return Boolean(threadId && pendingHydrationsByThreadId.has(threadId));
}

function getLiveThreadIdFromMessage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  if (payload.error) return '';
  const result = payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
    ? payload.result
    : null;
  if (result && result.thread && typeof result.thread === 'object') {
    return String(result.thread.id || '').trim();
  }
  const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? payload.params
    : null;
  if (!params) return '';
  const method = String(payload.method || '').trim();
  if (method === 'thread/started') {
    const thread = params.thread && typeof params.thread === 'object' && !Array.isArray(params.thread)
      ? params.thread
      : {};
    return String(thread.id || '').trim();
  }
  if (method === 'turn/started' || method === 'thread/status/changed' || method === 'thread/tokenUsage/updated') {
    return String(params.threadId || params.thread_id || '').trim();
  }
  return '';
}

function getClosedThreadIdFromMessage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  if (String(payload.method || '').trim() !== 'thread/closed') return '';
  const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? payload.params
    : {};
  return String(params.threadId || params.thread_id || '').trim();
}

function getThreadIdleStatusIdFromMessage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  if (String(payload.method || '').trim() !== 'thread/status/changed') return '';
  const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? payload.params
    : {};
  const status = params.status && typeof params.status === 'object' && !Array.isArray(params.status)
    ? params.status
    : {};
  const statusType = String(status.type || '').trim();
  if (statusType !== 'idle' && statusType !== 'notLoaded') return '';
  return String(params.threadId || params.thread_id || '').trim();
}

function getTurnLifecycleFromMessage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const method = String(payload.method || '').trim();
  if (method !== 'turn/started' && method !== 'turn/completed') return null;
  const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? payload.params
    : {};
  const threadId = String(params.threadId || params.thread_id || '').trim();
  const turnId = String(params.turnId || params.turn_id || '').trim();
  if (!threadId) return null;
  return {
    type: method === 'turn/started' ? 'started' : 'completed',
    threadId,
    turnId
  };
}

function buildCodexAppServerSessionEvent(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const method = String(payload.method || '').trim();
  const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? payload.params
    : {};
  let eventName = '';
  let type = '';
  let threadId = '';
  let turnId = '';

  if (method === 'turn/started' || method === 'turn/completed') {
    threadId = String(params.threadId || params.thread_id || '').trim();
    turnId = String(params.turnId || params.turn_id || '').trim();
    eventName = method === 'turn/started' ? 'AppServerTurnStarted' : 'AppServerTurnCompleted';
    type = method === 'turn/started' ? 'session:turn-started' : 'session:turn-completed';
  } else if (method === 'thread/status/changed') {
    threadId = String(params.threadId || params.thread_id || '').trim();
    const status = params.status && typeof params.status === 'object' && !Array.isArray(params.status)
      ? params.status
      : {};
    const statusType = String(status.type || '').trim();
    eventName = 'AppServerThreadStatusChanged';
    type = statusType === 'active' ? 'session:turn-started' : 'session:turn-updated';
  } else if (method === 'thread/closed') {
    threadId = String(params.threadId || params.thread_id || '').trim();
    eventName = 'AppServerThreadClosed';
    type = 'session:closed';
  }

  if (!threadId || !eventName || !type) return null;
  return {
    provider: 'codex',
    eventName,
    source: 'codex-app-server-proxy',
    payload: {
      provider: 'codex',
      source: 'codex-app-server-proxy',
      session_id: threadId,
      eventName,
      type,
      turn_id: turnId,
      timestamp: new Date(Number(options.nowMs) || Date.now()).toISOString()
    }
  };
}

function createCodexAppServerSessionEventPublisher(options = {}) {
  const receiverUrl = String(options.receiverUrl || '').trim();
  const postSessionEvent = typeof options.postSessionEvent === 'function'
    ? options.postSessionEvent
    : async (url, body) => postJson(url, body, { timeoutMs: options.timeoutMs || 2000 });
  const writeTrace = typeof options.writeTrace === 'function' ? options.writeTrace : () => {};
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now();
  if (!receiverUrl) return () => {};

  return (payload) => {
    const body = buildCodexAppServerSessionEvent(payload, { nowMs: nowMs() });
    if (!body) return;
    Promise.resolve()
      .then(() => postSessionEvent(receiverUrl, body))
      .then((result) => {
        if (result && result.ok) return;
        writeTrace({
          direction: 'proxy_internal',
          action: 'codex_app_server_session_event_failed',
          eventName: body.eventName,
          threadId: body.payload.session_id,
          error: sanitizeTraceText(result && (result.error || result.statusCode) || 'request_failed')
        });
      })
      .catch((error) => {
        writeTrace({
          direction: 'proxy_internal',
          action: 'codex_app_server_session_event_failed',
          eventName: body.eventName,
          threadId: body.payload.session_id,
          error: sanitizeTraceText(error && error.message || error)
        });
      });
  };
}

function buildCodexThreadStatusNotification(event) {
  const threadId = String(event && (event.sessionId || event.session_id) || '').trim();
  if (!threadId) return null;
  const type = String(event && event.type || '').trim();
  const status = type === 'session:turn-started'
    ? { type: 'active', activeFlags: [] }
    : { type: 'notLoaded' };
  return {
    method: 'thread/status/changed',
    params: {
      threadId,
      status
    }
  };
}

function createCodexSessionNotificationPoller(options = {}) {
  const fs = options.fs || require('node:fs');
  const queueFile = String(options.queueFile || '').trim();
  const liveThreadIds = options.liveThreadIds;
  const writeNotification = typeof options.writeNotification === 'function'
    ? options.writeNotification
    : null;
  const writeTrace = typeof options.writeTrace === 'function' ? options.writeTrace : () => {};
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || SESSION_NOTIFICATION_POLL_INTERVAL_MS);
  const debounceMs = Math.max(0, Number(options.debounceMs) || SESSION_NOTIFICATION_DEBOUNCE_MS);
  const pendingByThreadId = new Map();
  let offset = 0;
  let timer = null;

  if (options.startAtEnd !== false && queueFile && fs && typeof fs.existsSync === 'function' && fs.existsSync(queueFile)) {
    try {
      offset = Number(fs.statSync(queueFile).size) || 0;
    } catch (_error) {
      offset = 0;
    }
  }

  const flushThread = (threadId) => {
    const entry = pendingByThreadId.get(threadId);
    if (!entry) return;
    pendingByThreadId.delete(threadId);
    if (!liveThreadIds || typeof liveThreadIds.has !== 'function' || !liveThreadIds.has(threadId)) {
      return;
    }
    const notification = buildCodexThreadStatusNotification(entry.event);
    if (!notification || !writeNotification) return;
    writeTrace({
      direction: 'proxy_internal',
      action: 'codex_session_notification',
      threadId,
      eventType: String(entry.event && entry.event.type || ''),
      source: String(entry.event && entry.event.source || '')
    });
    writeNotification(notification);
  };

  const scheduleEvent = (event) => {
    const threadId = String(event && event.sessionId || '').trim();
    if (!threadId) return;
    const existing = pendingByThreadId.get(threadId);
    if (existing && existing.timer) clearTimeout(existing.timer);
    const timerHandle = setTimeout(() => flushThread(threadId), debounceMs);
    if (typeof timerHandle.unref === 'function') timerHandle.unref();
    pendingByThreadId.set(threadId, {
      event,
      timer: timerHandle
    });
  };

  const poll = () => {
    const result = readCodexSessionNotificationsSince(fs, queueFile, offset);
    offset = result.offset;
    for (const event of result.events) {
      scheduleEvent(event);
    }
  };

  if (queueFile && writeNotification) {
    timer = setInterval(poll, pollIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    poll();
  }

  return {
    poll,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const entry of pendingByThreadId.values()) {
        if (entry && entry.timer) clearTimeout(entry.timer);
      }
      pendingByThreadId.clear();
    }
  };
}

function rewriteStaleTurnSteerAsStart(payload, activeTurnIdsByThreadId) {
  if (!payload || payload.method !== 'turn/steer') return { payload, changed: false };
  const threadId = getThreadRequestId(payload);
  if (!threadId) return { payload, changed: false };
  const originalParams = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? payload.params
    : {};
  const expectedTurnId = String(originalParams.expectedTurnId || originalParams.expected_turn_id || '').trim();
  if (!expectedTurnId) return { payload, changed: false };
  const activeTurnId = activeTurnIdsByThreadId && typeof activeTurnIdsByThreadId.get === 'function'
    ? String(activeTurnIdsByThreadId.get(threadId) || '').trim()
    : '';
  if (activeTurnId) return { payload, changed: false };
  const params = { ...originalParams };
  delete params.expectedTurnId;
  delete params.expected_turn_id;
  return {
    payload: {
      ...payload,
      method: 'turn/start',
      params
    },
    changed: true,
    threadId,
    expectedTurnId
  };
}

function shouldAggregateThreadList(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.method !== 'thread/list') return false;
  const params = payload.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  if (params.cursor) return false;
  if (params.archived !== false) return false;
  if (!isInteractiveThreadSourceKinds(params.sourceKinds)) return false;
  return true;
}

function normalizeThreadSourceKind(sourceKind) {
  return String(sourceKind || '').trim();
}

function isInteractiveThreadSourceKinds(sourceKinds) {
  if (!Array.isArray(sourceKinds) || sourceKinds.length === 0) return true;
  const allowed = new Set(['cli', 'vscode']);
  for (const sourceKind of sourceKinds) {
    if (!allowed.has(normalizeThreadSourceKind(sourceKind))) return false;
  }
  return true;
}

function buildAggregatePageRequest(baseRequest, cursor, requestId, remainingItems) {
  const baseParams = baseRequest.params || {};
  const requestedLimit = Number(baseParams.limit);
  const fallbackLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : 50;
  const requestedPageLimit = Number.isFinite(remainingItems) && remainingItems > 0
    ? Math.min(fallbackLimit, remainingItems)
    : fallbackLimit;
  return {
    ...baseRequest,
    id: requestId,
    params: {
      ...baseParams,
      limit: requestedPageLimit,
      cursor,
      useStateDbOnly: true
    }
  };
}

function mergeThreadListData(existingData, nextData) {
  const seen = new Set();
  const merged = [];
  for (const item of Array.isArray(existingData) ? existingData : []) {
    const key = item && item.id ? String(item.id) : '';
    if (key) seen.add(key);
    merged.push(item);
  }
  for (const item of Array.isArray(nextData) ? nextData : []) {
    const key = item && item.id ? String(item.id) : '';
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(item);
  }
  return merged;
}

function timestampToSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 100000000000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 100000000000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function durationToMs(duration) {
  if (!duration || typeof duration !== 'object') return null;
  const secs = Number(duration.secs || 0);
  const nanos = Number(duration.nanos || 0);
  const total = (Number.isFinite(secs) ? secs * 1000 : 0) + (Number.isFinite(nanos) ? nanos / 1000000 : 0);
  return Number.isFinite(total) ? Math.round(total) : null;
}

function truncateText(value, maxChars) {
  const text = String(value || '');
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[output truncated by ai-home codex app hook]`;
}

function normalizeCommandSource(source) {
  const normalized = String(source || '').trim();
  if (normalized === 'unified_exec_startup') return 'unifiedExecStartup';
  if (normalized === 'unified_exec_interaction') return 'unifiedExecInteraction';
  if (normalized === 'user_shell') return 'userShell';
  return 'agent';
}

function normalizeCommandStatus(status, exitCode) {
  const normalized = String(status || '').trim();
  if (normalized === 'failed' || normalized === 'declined' || normalized === 'inProgress') return normalized;
  if (Number.isFinite(Number(exitCode)) && Number(exitCode) !== 0) return 'failed';
  return 'completed';
}

function normalizeSessionSource(source) {
  const normalized = String(source || '').trim();
  if (normalized === 'cli' || normalized === 'vscode' || normalized === 'exec' || normalized === 'appServer') {
    return normalized;
  }
  return normalized ? { custom: normalized } : 'unknown';
}

function normalizeApprovalMode(approvalMode) {
  const normalized = String(approvalMode || '').trim();
  if (normalized === 'never' || normalized === 'on-request' || normalized === 'on-failure' || normalized === 'untrusted') {
    return normalized;
  }
  return 'on-request';
}

function normalizeSandboxPolicy(rawPolicy) {
  if (rawPolicy && typeof rawPolicy === 'object') return rawPolicy;
  let parsed = null;
  try {
    parsed = rawPolicy ? JSON.parse(String(rawPolicy)) : null;
  } catch (_error) {}
  const type = String(parsed && parsed.type || rawPolicy || '').trim();
  if (type === 'danger-full-access' || type === 'dangerFullAccess') {
    return { type: 'dangerFullAccess' };
  }
  if (type === 'read-only' || type === 'readOnly') {
    return { type: 'readOnly', networkAccess: Boolean(parsed && parsed.networkAccess) };
  }
  if (type === 'workspace-write' || type === 'workspaceWrite') {
    return {
      type: 'workspaceWrite',
      writableRoots: Array.isArray(parsed && parsed.writableRoots) ? parsed.writableRoots : [],
      networkAccess: Boolean(parsed && parsed.networkAccess),
      excludeTmpdirEnvVar: Boolean(parsed && parsed.excludeTmpdirEnvVar),
      excludeSlashTmp: Boolean(parsed && parsed.excludeSlashTmp)
    };
  }
  return { type: 'dangerFullAccess' };
}

function resolveThreadDisplayTitle(row) {
  if (!row || typeof row !== 'object') return '';
  return String(row.title || row.first_user_message || '').trim();
}

function createEmptyTurn(turnId, timestampSeconds) {
  return {
    id: turnId,
    items: [],
    itemsView: 'full',
    status: 'inProgress',
    error: null,
    startedAt: timestampSeconds,
    completedAt: null,
    durationMs: null,
    _lastActivityAt: timestampSeconds
  };
}

function normalizeStaleInProgressTurns(turns, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const staleAfterMs = Number.isFinite(Number(options.staleInProgressAfterMs))
    ? Number(options.staleInProgressAfterMs)
    : STALE_IN_PROGRESS_TURN_AFTER_MS;
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (turn && turn.status === 'inProgress' && staleAfterMs >= 0) {
      const lastActivityAt = Number.isFinite(Number(turn._lastActivityAt))
        ? Number(turn._lastActivityAt)
        : Number(turn.startedAt);
      if (
        Number.isFinite(lastActivityAt)
        && Number.isFinite(nowMs)
        && nowMs - (lastActivityAt * 1000) > staleAfterMs
      ) {
        turn.status = 'interrupted';
        turn.completedAt = lastActivityAt;
        if (Number.isFinite(Number(turn.startedAt))) {
          turn.durationMs = Math.max(0, Math.round((lastActivityAt - Number(turn.startedAt)) * 1000));
        }
      }
    }
    if (turn && Object.prototype.hasOwnProperty.call(turn, '_lastActivityAt')) {
      delete turn._lastActivityAt;
    }
  }
  return turns;
}

function parseRecentCodexRolloutTurns(text, options = {}) {
  const threadId = String(options.threadId || 'thread').trim() || 'thread';
  const cwd = String(options.cwd || '').trim();
  const maxCommandOutputChars = Number(options.maxCommandOutputChars) || FAST_THREAD_READ_MAX_COMMAND_OUTPUT_CHARS;
  const turns = [];
  const turnById = new Map();
  let currentTurn = null;
  let itemCounter = 0;

  const ensureTurn = (turnId, timestampSeconds) => {
    const normalizedTurnId = String(turnId || '').trim() || `${threadId}-tail-${turns.length + 1}`;
    if (turnById.has(normalizedTurnId)) {
      currentTurn = turnById.get(normalizedTurnId);
      if (timestampSeconds !== null) currentTurn._lastActivityAt = timestampSeconds;
      return currentTurn;
    }
    currentTurn = createEmptyTurn(normalizedTurnId, timestampSeconds);
    turnById.set(normalizedTurnId, currentTurn);
    turns.push(currentTurn);
    return currentTurn;
  };

  const appendItem = (turn, item) => {
    itemCounter += 1;
    turn.items.push({
      id: `item-${itemCounter}`,
      ...item
    });
  };

  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line) continue;
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch (_error) {
      continue;
    }
    if (!entry || entry.type !== 'event_msg' || !entry.payload || typeof entry.payload !== 'object') {
      continue;
    }
    const payload = entry.payload;
    const eventType = String(payload.type || '');
    const eventSeconds = timestampToSeconds(entry.timestamp);

    if (eventType === 'task_started') {
      ensureTurn(payload.turn_id, eventSeconds);
      continue;
    }

    if (eventType === 'user_message') {
      const turn = currentTurn || ensureTurn('', eventSeconds);
      if (eventSeconds !== null) turn._lastActivityAt = eventSeconds;
      const content = [];
      const message = String(payload.message || '');
      if (message) {
        content.push({
          type: 'text',
          text: message,
          text_elements: Array.isArray(payload.text_elements) ? payload.text_elements : []
        });
      }
      for (const image of Array.isArray(payload.images) ? payload.images : []) {
        const url = typeof image === 'string' ? image : String(image && image.url || '').trim();
        if (url) content.push({ type: 'image', url });
      }
      for (const localImage of Array.isArray(payload.local_images) ? payload.local_images : []) {
        const imagePath = typeof localImage === 'string' ? localImage : String(localImage && localImage.path || '').trim();
        if (imagePath) content.push({ type: 'localImage', path: imagePath });
      }
      if (content.length > 0) {
        appendItem(turn, { type: 'userMessage', content });
      }
      continue;
    }

    if (eventType === 'agent_message') {
      const message = String(payload.message || '');
      if (!message) continue;
      const turn = currentTurn || ensureTurn('', eventSeconds);
      if (eventSeconds !== null) turn._lastActivityAt = eventSeconds;
      appendItem(turn, {
        type: 'agentMessage',
        text: message,
        phase: payload.phase || null,
        memoryCitation: payload.memory_citation || null
      });
      continue;
    }

    if (eventType === 'exec_command_end') {
      const turn = ensureTurn(payload.turn_id, eventSeconds);
      if (eventSeconds !== null) turn._lastActivityAt = eventSeconds;
      const command = Array.isArray(payload.command)
        ? payload.command.map((part) => String(part || '')).join(' ')
        : String(payload.command || '');
      appendItem(turn, {
        type: 'commandExecution',
        command,
        cwd: String(payload.cwd || cwd || ''),
        processId: payload.process_id ? String(payload.process_id) : null,
        source: normalizeCommandSource(payload.source),
        status: normalizeCommandStatus(payload.status, payload.exit_code),
        commandActions: [],
        aggregatedOutput: truncateText(payload.aggregated_output || payload.formatted_output || payload.stdout || payload.stderr || '', maxCommandOutputChars),
        exitCode: Number.isFinite(Number(payload.exit_code)) ? Number(payload.exit_code) : null,
        durationMs: durationToMs(payload.duration)
      });
      continue;
    }

    if (eventType === 'task_complete') {
      const turn = ensureTurn(payload.turn_id, eventSeconds);
      if (eventSeconds !== null) turn._lastActivityAt = eventSeconds;
      turn.status = 'completed';
      turn.completedAt = eventSeconds;
      if (turn.startedAt !== null && eventSeconds !== null) {
        turn.durationMs = Math.max(0, Math.round((eventSeconds - turn.startedAt) * 1000));
      }
      continue;
    }

    if (eventType === 'turn_aborted') {
      const turn = currentTurn || ensureTurn(payload.turn_id, eventSeconds);
      if (eventSeconds !== null) turn._lastActivityAt = eventSeconds;
      turn.status = 'interrupted';
      turn.completedAt = eventSeconds;
      continue;
    }

    if (eventType === 'error') {
      const turn = currentTurn || ensureTurn(payload.turn_id, eventSeconds);
      if (eventSeconds !== null) turn._lastActivityAt = eventSeconds;
      turn.status = 'failed';
      turn.error = {
        message: String(payload.message || 'thread failed')
      };
    }
  }

  normalizeStaleInProgressTurns(turns, options);
  return turns.filter((turn) => turn.items.length > 0);
}

function readRecentRolloutTurns(fs, rolloutPath, statSize, options = {}) {
  const turnLimit = Number(options.turnLimit) || FAST_THREAD_READ_TURN_LIMIT;
  const initialBytes = Number(options.initialBytes) || FAST_THREAD_READ_INITIAL_BYTES;
  const maxBytes = Number(options.maxBytes) || FAST_THREAD_READ_MAX_BYTES;
  const size = Number(statSize) || 0;
  let bytesToRead = Math.min(size, initialBytes);
  let bestTurns = [];

  while (bytesToRead > 0) {
    const start = Math.max(0, size - bytesToRead);
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    let fd = null;
    try {
      fd = fs.openSync(rolloutPath, 'r');
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (_error) {}
      }
    }

    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    bestTurns = parseRecentCodexRolloutTurns(text, options);
    if (bestTurns.length >= turnLimit || start === 0 || bytesToRead >= maxBytes) {
      return bestTurns.slice(-turnLimit);
    }
    bytesToRead = Math.min(size, bytesToRead * 2, maxBytes);
  }

  return bestTurns.slice(-turnLimit);
}

function buildThreadFromStateRow(row, turns, overrides = {}) {
  const currentProvider = String(overrides.modelProvider || row.model_provider || '').trim();
  const createdAt = timestampToSeconds(row.created_at_ms || row.created_at);
  const updatedAt = timestampToSeconds(row.updated_at_ms || row.updated_at) || createdAt;
  const title = resolveThreadDisplayTitle(row);
  return {
    id: String(row.id || ''),
    sessionId: String(row.id || ''),
    forkedFromId: null,
    title,
    preview: String(row.first_user_message || row.title || ''),
    ephemeral: false,
    modelProvider: currentProvider,
    createdAt: createdAt || 0,
    updatedAt: updatedAt || 0,
    status: overrides.status || { type: 'notLoaded' },
    path: row.rollout_path ? String(row.rollout_path) : null,
    cwd: String(row.cwd || ''),
    cliVersion: String(row.cli_version || ''),
    source: normalizeSessionSource(row.source),
    threadSource: null,
    agentNickname: row.agent_nickname || null,
    agentRole: row.agent_role || null,
    gitInfo: row.git_sha || row.git_branch || row.git_origin_url
      ? {
        sha: row.git_sha || null,
        branch: row.git_branch || null,
        originUrl: row.git_origin_url || null
      }
      : null,
    name: title || null,
    turns
  };
}

function buildFastThreadReadResponse(payload, deps = {}) {
  if (!payload || (payload.method !== 'thread/read' && payload.method !== 'thread/resume')) return null;
  const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? payload.params
    : {};
  if (payload.method === 'thread/read' && params.includeTurns !== true) return null;
  const threadId = getThreadRequestId(payload);
  if (!threadId) return null;

  const fs = deps.fs || require('node:fs');
  const found = findThreadStateRow(threadId, deps);
  const row = found && found.row;
  const rolloutPath = String(row && row.rollout_path || '').trim();
  if (!row || !rolloutPath) return null;

  let stat = null;
  try {
    stat = fs.statSync(rolloutPath);
  } catch (_error) {
    return null;
  }
  const size = Number(stat && stat.size) || 0;
  const minBytes = Number(deps.fastReadMinBytes) || FAST_THREAD_READ_MIN_BYTES;
  if (size < minBytes) return null;

  const currentConfig = readCurrentCodexRuntimeConfig(fs, resolveCodexStateHome(deps), deps);
  const modelProvider = isAihManagedProvider(currentConfig.modelProvider)
    ? currentConfig.modelProvider
    : String(row.model_provider || '').trim();
  const model = isAihManagedProvider(currentConfig.modelProvider) && currentConfig.model
    ? currentConfig.model
    : String(row.model || '').trim();
  const activeTurnIdsByThreadId = deps.activeTurnIdsByThreadId;
  const hasTrackedActiveTurn = activeTurnIdsByThreadId && typeof activeTurnIdsByThreadId.has === 'function'
    ? activeTurnIdsByThreadId.has(threadId)
    : null;
  const turns = readRecentRolloutTurns(fs, rolloutPath, size, {
    threadId,
    cwd: row.cwd,
    turnLimit: deps.fastReadTurnLimit,
    initialBytes: deps.fastReadInitialBytes,
    maxBytes: deps.fastReadMaxBytes,
    maxCommandOutputChars: deps.fastReadMaxCommandOutputChars,
    nowMs: deps.nowMs,
    staleInProgressAfterMs: hasTrackedActiveTurn === false
      ? 0
      : deps.staleInProgressAfterMs
  });
  const thread = buildThreadFromStateRow(row, turns, {
    modelProvider,
    status: payload.method === 'thread/resume' ? { type: 'idle' } : { type: 'notLoaded' }
  });
  if (payload.method === 'thread/read') {
    return {
      id: payload.id,
      result: { thread },
      meta: {
        threadId,
        rolloutPath,
        rolloutBytes: size,
        turnsReturned: turns.length
      }
    };
  }
  return {
    id: payload.id,
    result: {
      thread,
      threadIds: [threadId],
      model,
      modelProvider,
      serviceTier: null,
      cwd: String(row.cwd || ''),
      instructionSources: [],
      approvalPolicy: normalizeApprovalMode(row.approval_mode),
      approvalsReviewer: 'user',
      sandbox: normalizeSandboxPolicy(row.sandbox_policy),
      permissionProfile: { type: 'disabled' },
      activePermissionProfile: null,
      reasoningEffort: row.reasoning_effort || null
    },
    meta: {
      threadId,
      rolloutPath,
      rolloutBytes: size,
      turnsReturned: turns.length
    }
  };
}

function patchThreadConfigResponse(line, context) {
  if (!context || (!context.modelProvider && !context.model)) return line;
  const parsed = tryParseJson(line);
  if (!parsed || !parsed.result || typeof parsed.result !== 'object') return line;
  let changed = false;
  const result = { ...parsed.result };
  if (result.thread && typeof result.thread === 'object') {
    result.thread = { ...result.thread };
    if (context.modelProvider && result.thread.modelProvider !== context.modelProvider) {
      result.thread.modelProvider = context.modelProvider;
      changed = true;
    }
  }
  if (context.modelProvider && Object.prototype.hasOwnProperty.call(result, 'modelProvider') && result.modelProvider !== context.modelProvider) {
    result.modelProvider = context.modelProvider;
    changed = true;
  }
  if (context.model && Object.prototype.hasOwnProperty.call(result, 'model') && result.model !== context.model) {
    result.model = context.model;
    changed = true;
  }
  if (!changed) return line;
  return JSON.stringify({
    ...parsed,
    result
  });
}

function patchAccountReadResponse(line, options = {}) {
  const parsed = tryParseJson(line);
  if (!parsed || parsed.error || !parsed.result || typeof parsed.result !== 'object') return line;

  const result = parsed.result;
  if (result.account != null || result.requiresOpenaiAuth !== false) return line;

  const fs = options.fs || require('node:fs');
  const currentConfig = readCurrentCodexRuntimeConfig(fs, resolveCodexStateHome(options), options);
  if (!isAihManagedProvider(currentConfig.modelProvider)) return line;

  const account = resolveCodexDesktopChatGptAccount(fs, options);
  if (!account) return line;

  return JSON.stringify({
    ...parsed,
    result: {
      ...result,
      account,
      requiresOpenaiAuth: false
    }
  });
}

function patchAuthStatusResponse(line, context = {}, options = {}) {
  const parsed = tryParseJson(line);
  if (!parsed || parsed.error || !parsed.result || typeof parsed.result !== 'object') return line;

  const fs = options.fs || require('node:fs');
  const currentConfig = readCurrentCodexRuntimeConfig(fs, resolveCodexStateHome(options), options);
  if (!isAihManagedProvider(currentConfig.modelProvider)) return line;

  const includeToken = context.includeToken !== false;
  const identity = resolveCodexDesktopChatGptIdentity(fs, {
    ...options,
    requireAccessToken: true
  });
  if (!identity || !identity.accessToken) return line;

  return JSON.stringify({
    ...parsed,
    result: {
      ...parsed.result,
      authMethod: 'chatgpt',
      authToken: includeToken ? identity.accessToken : null,
      requiresOpenaiAuth: false
    }
  });
}

function getThreadObjectId(thread) {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return '';
  return String(thread.id || thread.sessionId || thread.threadId || '').trim();
}

function resolveThreadTitleForPatch(thread, options = {}) {
  const existing = String(
    thread && (thread.title || thread.name || thread.preview || thread.first_user_message) || ''
  ).trim();
  if (existing) return existing;
  const threadId = getThreadObjectId(thread);
  if (!threadId) return '';
  const found = findThreadStateRow(threadId, options);
  return resolveThreadDisplayTitle(found && found.row);
}

function patchThreadObjectTitleFields(thread, options = {}) {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return { thread, changed: false };
  const title = resolveThreadTitleForPatch(thread, options);
  if (!title) return { thread, changed: false };
  let changed = false;
  const next = { ...thread };
  if (!String(next.title || '').trim()) {
    next.title = title;
    changed = true;
  }
  if (!String(next.name || '').trim()) {
    next.name = title;
    changed = true;
  }
  if (!String(next.preview || '').trim()) {
    next.preview = title;
    changed = true;
  }
  return changed ? { thread: next, changed: true } : { thread, changed: false };
}

function patchThreadTitleFieldsResponse(line, options = {}) {
  const parsed = tryParseJson(line);
  if (!parsed || parsed.error || !parsed.result || typeof parsed.result !== 'object' || Array.isArray(parsed.result)) {
    return line;
  }
  const result = parsed.result;
  let changed = false;
  const nextResult = { ...result };
  if (Array.isArray(result.data)) {
    const nextData = result.data.map((item) => {
      const patched = patchThreadObjectTitleFields(item, options);
      if (patched.changed) changed = true;
      return patched.thread;
    });
    if (changed) nextResult.data = nextData;
  }
  if (result.thread && typeof result.thread === 'object' && !Array.isArray(result.thread)) {
    const patched = patchThreadObjectTitleFields(result.thread, options);
    if (patched.changed) {
      nextResult.thread = patched.thread;
      changed = true;
    }
  }
  if (!changed) return line;
  return JSON.stringify({
    ...parsed,
    result: nextResult
  });
}

function normalizeThreadGoalStatus(status) {
  const normalized = String(status || '').trim();
  if (normalized === 'budget_limited') return 'budgetLimited';
  if (normalized === 'budgetLimited') return 'budgetLimited';
  if (normalized === 'active' || normalized === 'paused' || normalized === 'complete') return normalized;
  return '';
}

function timestampMsToSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric / 1000);
}

function normalizeNullableInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function readThreadGoalFromGoalDb(threadId, deps = {}) {
  const id = String(threadId || '').trim();
  if (!id) return null;
  const fs = deps.fs || require('node:fs');
  const codexHome = String(deps.codexHome || resolveCodexStateHome(deps)).trim();
  if (!codexHome) return null;
  const goalsDbPath = path.join(codexHome, 'goals_1.sqlite');
  try {
    if (!fs.existsSync(goalsDbPath)) return null;
  } catch (_error) {
    return null;
  }
  const DatabaseSync = deps.DatabaseSync || getDatabaseSyncCtor();
  if (!DatabaseSync) return null;

  let db = null;
  try {
    db = new DatabaseSync(goalsDbPath);
    db.exec('PRAGMA busy_timeout = 1000;');
    const columns = getSqliteTableColumns(db, 'thread_goals');
    const requiredColumns = [
      'thread_id',
      'objective',
      'status',
      'token_budget',
      'tokens_used',
      'time_used_seconds',
      'created_at_ms',
      'updated_at_ms'
    ];
    if (requiredColumns.some((columnName) => !columns.has(columnName))) return null;
    const row = db.prepare(`
      SELECT thread_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms
      FROM thread_goals
      WHERE thread_id = ?
    `).get(id);
    if (!row) return null;
    const status = normalizeThreadGoalStatus(row.status);
    if (!status) return null;
    return {
      threadId: String(row.thread_id || id),
      objective: String(row.objective || ''),
      status,
      tokenBudget: normalizeNullableInteger(row.token_budget),
      tokensUsed: normalizeNullableInteger(row.tokens_used) || 0,
      timeUsedSeconds: normalizeNullableInteger(row.time_used_seconds) || 0,
      createdAt: timestampMsToSeconds(row.created_at_ms),
      updatedAt: timestampMsToSeconds(row.updated_at_ms)
    };
  } catch (_error) {
    return null;
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_closeError) {}
    }
  }
}

function patchThreadGoalGetResponse(line, context = {}, options = {}) {
  if (!context || !context.threadId) return line;
  const parsed = tryParseJson(line);
  if (!parsed || !parsed.error) return line;
  const goal = readThreadGoalFromGoalDb(context.threadId, options);
  return JSON.stringify({
    id: parsed.id,
    result: { goal }
  });
}

function cleanupTemporaryFiles(fs, filePaths) {
  for (const filePath of Array.isArray(filePaths) ? filePaths : []) {
    const target = String(filePath || '').trim();
    if (!target) continue;
    try {
      if (typeof fs.rmSync === 'function') {
        fs.rmSync(target, { force: true });
      } else if (fs.existsSync(target)) {
        fs.unlinkSync(target);
      }
    } catch (_error) {}
  }
}

function forwardExitCode(child, processObj) {
  child.on('exit', (code, signal) => {
    if (signal) {
      try {
        processObj.kill(processObj.pid, signal);
        return;
      } catch (_error) {}
    }
    const exitCode = Number(code);
    processObj.exit(Number.isFinite(exitCode) ? exitCode : 0);
  });
}

function hasExplicitRemoteArg(args) {
  return (Array.isArray(args) ? args : []).some((arg) => {
    const text = String(arg || '').trim();
    return text === '--remote'
      || text.startsWith('--remote=')
      || text === '--remote-auth-token-env'
      || text.startsWith('--remote-auth-token-env=');
  });
}

function normalizeRemoteHost(host) {
  const value = String(host || '').trim();
  if (!value || value === '0.0.0.0' || value === '::') return '127.0.0.1';
  return value;
}

function canConnectToTcpEndpoint(host, port, timeoutMs = 180) {
  const safePort = Number(port);
  if (!host || !Number.isFinite(safePort) || safePort <= 0) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: safePort });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_error) {}
      resolve(Boolean(ok));
    };
    socket.setTimeout(Math.max(50, Number(timeoutMs) || 180));
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function resolveCliResumeRemoteConfig(fs, stateFile) {
  const aiHomeDir = path.dirname(String(stateFile || '').trim());
  const config = readServerConfig({ fs, aiHomeDir });
  const host = normalizeRemoteHost(config.host);
  const port = Number(config.port);
  if (!host || !Number.isFinite(port) || port <= 0) return null;
  return {
    host,
    port,
    remoteUrl: `ws://${host}:${port}`,
    authToken: String(config.apiKey || '').trim()
  };
}

function buildCodexCliResumeArgs(forwardArgs, remoteConfig) {
  const args = Array.isArray(forwardArgs) ? [...forwardArgs] : [];
  if (String(args[0] || '').trim() !== 'resume') return args;
  if (!remoteConfig || hasExplicitRemoteArg(args)) return args;

  const injected = ['resume', '--remote', remoteConfig.remoteUrl];
  if (remoteConfig.authToken) {
    injected.push('--remote-auth-token-env', 'AIH_CODEX_REMOTE_AUTH_TOKEN');
  }
  return [...injected, ...args.slice(1)];
}

async function runCodexCliResume(argv, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const spawnImpl = deps.spawn || spawn;
  const processObj = deps.processObj || process;
  const parsed = parseProxyArgs(argv);
  if (!parsed.upstream) {
    throw new Error('missing_upstream_binary');
  }

  const env = { ...(processObj.env || process.env) };
  let args = parsed.forwardArgs;
  let scopedResumeProxy = null;
  if (
    String(env.AIH_CODEX_DISABLE_REMOTE_RESUME || '0') !== '1'
    && !hasExplicitRemoteArg(args)
  ) {
    const remoteConfig = resolveCliResumeRemoteConfig(fs, parsed.stateFile);
    const wantsAllProjects = args.some((arg) => String(arg || '').trim() === '--all');
    const canConnect = deps.canConnectToTcpEndpoint || canConnectToTcpEndpoint;
    const remoteReady = remoteConfig
      ? await canConnect(remoteConfig.host, remoteConfig.port, deps.connectTimeoutMs)
      : false;
    if (remoteReady) {
      let effectiveRemoteConfig = wantsAllProjects ? remoteConfig : null;
      if (!wantsAllProjects && typeof processObj.cwd === 'function') {
        const cwd = String(processObj.cwd() || '').trim();
        if (cwd) {
          try {
            scopedResumeProxy = await startCodexCliResumeCwdProxy(remoteConfig, { cwd });
            effectiveRemoteConfig = { remoteUrl: scopedResumeProxy.remoteUrl, authToken: '' };
          } catch (error) {
            processObj.stderr.write(
              `[aih] Codex scoped resume proxy failed; falling back to native resume: ${String((error && error.message) || error || 'unknown')}\n`
            );
          }
        }
      }
      if (effectiveRemoteConfig) {
        args = buildCodexCliResumeArgs(args, effectiveRemoteConfig);
        if (effectiveRemoteConfig.authToken) {
          env.AIH_CODEX_REMOTE_AUTH_TOKEN = effectiveRemoteConfig.authToken;
        }
      }
    }
  }

  const child = spawnImpl(parsed.upstream, args, {
    stdio: 'inherit',
    env
  });
  const closeScopedResumeProxy = () => {
    if (!scopedResumeProxy) return;
    try { scopedResumeProxy.close(); } catch (_error) {}
    scopedResumeProxy = null;
  };
  child.on('error', (error) => {
    closeScopedResumeProxy();
    processObj.stderr.write(`${String((error && error.message) || error || 'codex_resume_failed')}\n`);
    processObj.exit(1);
  });
  child.once('exit', closeScopedResumeProxy);
  forwardExitCode(child, processObj);
  return child;
}

function runCodexAppServerStdioProxy(argv, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const spawnImpl = deps.spawn || spawn;
  const processObj = deps.processObj || process;
  const parsed = parseProxyArgs(argv);
  if (parsed.runCliResume) {
    return runCodexCliResume(argv, { ...deps, fs, spawn: spawnImpl, processObj });
  }
  if (parsed.repairResumeVisibility) {
    return runCodexResumeVisibilityRepair(argv, { ...deps, fs, processObj });
  }
  if (!parsed.upstream) {
    throw new Error('missing_upstream_binary');
  }

  const state = readHookState(fs, parsed.stateFile);
  const writeTrace = createTraceWriter(fs, state);
  const aggregateContexts = new Map();
  const aggregateRequestIdToContextId = new Map();
  const responsePatchContexts = new Map();
  const accountReadResponseIds = new Set();
  const authStatusResponseContexts = new Map();
  const threadListResponseContexts = new Map();
  const threadGoalGetResponseContexts = new Map();
  const threadResumeResponseContexts = new Map();
  const suppressedResponseIds = new Set();
  const hydrationResponseIdToThreadId = new Map();
  const pendingHydrationsByThreadId = new Map();
  const liveThreadIds = new Set();
  const activeTurnIdsByThreadId = new Map();
  let sessionNotificationPoller = null;
  let hydrationRequestSeq = 0;
  let lastOptimizedRolloutRepairAtMs = 0;
  let lastMissingThreadTitleRepairAtMs = 0;
  if (!state.enabled) {
    const child = spawnImpl(parsed.upstream, parsed.forwardArgs, {
      stdio: 'inherit',
      env: processObj.env || process.env
    });
    forwardExitCode(child, processObj);
    return child;
  }

  const remoteControlProxy = startRemoteControlProxyProcess(fs, state, writeTrace, {
    ...deps,
    processObj
  });

  const spawnEnvResult = buildCodexAppServerSpawnEnv(fs, state, {
    ...deps,
    processObj,
    chatgptBaseUrl: remoteControlProxy && remoteControlProxy.baseUrl
  });
  if (spawnEnvResult.runtime) {
    writeTrace({
      direction: 'proxy_internal',
      action: 'prepare_desktop_runtime_home',
      runtimeHome: spawnEnvResult.runtime.runtimeHome,
      hostCodexHome: spawnEnvResult.runtime.hostCodexHome,
      accountId: spawnEnvResult.runtime.accountId,
      authType: spawnEnvResult.runtime.authType || ''
    });
  }

  const child = spawnImpl(parsed.upstream, parsed.forwardArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spawnEnvResult.env
  });
  if (remoteControlProxy && remoteControlProxy.child) {
    child.on('exit', () => {
      try { remoteControlProxy.child.kill('SIGTERM'); } catch (_error) {}
      cleanupTemporaryFiles(fs, [remoteControlProxy.suppressStateFile]);
    });
  }

  child.on('exit', () => {
    pendingHydrationsByThreadId.clear();
  });

  const repairMissingOptimizedRolloutPathsForList = (payload) => {
    if (!payload || payload.method !== 'thread/list') return;
    const nowMs = Date.now();
    if (nowMs - lastOptimizedRolloutRepairAtMs >= OPTIMIZED_ROLLOUT_REPAIR_INTERVAL_MS) {
      lastOptimizedRolloutRepairAtMs = nowMs;
      const result = repairMissingOptimizedRolloutPaths({
        fs,
        processObj,
        DatabaseSync: deps.DatabaseSync
      });
      if (result.repaired > 0 || result.failed > 0) {
        writeTrace({
          direction: 'proxy_internal',
          action: 'repair_missing_optimized_rollout_paths',
          checked: result.checked,
          repaired: result.repaired,
          failed: result.failed,
          threadIds: result.items.map((item) => item.threadId).filter(Boolean)
        });
      }
    }
    if (nowMs - lastMissingThreadTitleRepairAtMs < MISSING_THREAD_TITLE_REPAIR_INTERVAL_MS) return;
    lastMissingThreadTitleRepairAtMs = nowMs;
    const titleResult = repairMissingThreadTitleFields({
      fs,
      processObj,
      DatabaseSync: deps.DatabaseSync
    });
    if (titleResult.repaired > 0 || titleResult.failed > 0) {
      writeTrace({
        direction: 'proxy_internal',
        action: 'repair_missing_thread_title_fields',
        checked: titleResult.checked,
        repaired: titleResult.repaired,
        failed: titleResult.failed,
        threadIds: titleResult.items.map((item) => item.threadId).filter(Boolean)
      });
    }
  };

  const startHiddenHydration = (hydrationRequest, hydrationThreadId, pendingPayloads, action) => {
    if (!hydrationRequest || !hydrationThreadId) return false;
    const existing = pendingHydrationsByThreadId.get(hydrationThreadId);
    if (existing) {
      for (const payload of pendingPayloads || []) {
        existing.pendingPayloads.push(payload);
      }
      existing.remoteSuppressExpiresAtMs = Date.now() + REMOTE_HYDRATION_SUPPRESSION_TTL_MS;
      writeRemoteHydrationSuppressionState(
        fs,
        remoteControlProxy && remoteControlProxy.suppressStateFile,
        pendingHydrationsByThreadId
      );
      return true;
    }
    const hydrationResponseId = String(hydrationRequest.id);
    const remoteSuppressExpiresAtMs = Date.now() + REMOTE_HYDRATION_SUPPRESSION_TTL_MS;
    suppressedResponseIds.add(hydrationResponseId);
    hydrationResponseIdToThreadId.set(hydrationResponseId, hydrationThreadId);
    pendingHydrationsByThreadId.set(hydrationThreadId, {
      responseId: hydrationResponseId,
      pendingPayloads: [...(pendingPayloads || [])],
      remoteSuppressExpiresAtMs
    });
    writeRemoteHydrationSuppressionState(
      fs,
      remoteControlProxy && remoteControlProxy.suppressStateFile,
      pendingHydrationsByThreadId
    );
    const hydrationPayload = JSON.stringify(hydrationRequest);
    writeTrace({
      direction: 'proxy_to_upstream',
      action,
      threadId: hydrationThreadId,
      rewritten: hydrationPayload
    });
    child.stdin.write(`${hydrationPayload}\n`);
    return true;
  };

  const markTurnStartPending = (payload) => {
    if (!payload || payload.method !== 'turn/start') return;
    const threadId = getThreadRequestId(payload);
    if (threadId) activeTurnIdsByThreadId.set(threadId, PENDING_ACTIVE_TURN_ID);
  };

  const writeCodexSessionNotification = (payload) => {
    if (!payload || typeof payload !== 'object') return;
    processObj.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  const publishCodexAppServerSessionEvent = createCodexAppServerSessionEventPublisher({
    receiverUrl: state.providerHookReceiverUrl,
    postSessionEvent: deps.postSessionEvent,
    timeoutMs: deps.sessionEventPostTimeoutMs,
    writeTrace,
    nowMs: typeof deps.nowMs === 'function' ? deps.nowMs : undefined
  });

  const trackTurnLifecycleMessage = (payload) => {
    publishCodexAppServerSessionEvent(payload);
    const closedThreadId = getClosedThreadIdFromMessage(payload);
    if (closedThreadId) {
      liveThreadIds.delete(closedThreadId);
      activeTurnIdsByThreadId.delete(closedThreadId);
    }
    const liveThreadId = getLiveThreadIdFromMessage(payload);
    if (liveThreadId) liveThreadIds.add(liveThreadId);
    const idleThreadId = getThreadIdleStatusIdFromMessage(payload);
    if (idleThreadId) activeTurnIdsByThreadId.delete(idleThreadId);
    const lifecycle = getTurnLifecycleFromMessage(payload);
    if (!lifecycle) return;
    if (lifecycle.type === 'started') {
      activeTurnIdsByThreadId.set(lifecycle.threadId, lifecycle.turnId || PENDING_ACTIVE_TURN_ID);
      return;
    }
    const currentTurnId = String(activeTurnIdsByThreadId.get(lifecycle.threadId) || '').trim();
    if (
      !currentTurnId
      || !lifecycle.turnId
      || currentTurnId === lifecycle.turnId
      || currentTurnId === PENDING_ACTIVE_TURN_ID
    ) {
      activeTurnIdsByThreadId.delete(lifecycle.threadId);
    }
  };

  const queueFile = state.sessionNotificationQueueFile
    || resolveCodexSessionNotificationQueuePathFromStateFile(parsed.stateFile);
  sessionNotificationPoller = createCodexSessionNotificationPoller({
    fs,
    queueFile,
    liveThreadIds,
    writeTrace,
    writeNotification: writeCodexSessionNotification,
    pollIntervalMs: deps.sessionNotificationPollIntervalMs,
    debounceMs: deps.sessionNotificationDebounceMs
  });

  const stdinPump = createLinePump((line) => {
    const rewrittenPayload = rewriteCodexAppServerClientMessage(line);
    let parsedPayload = tryParseJson(rewrittenPayload);
    const threadConfigReconcile = reconcileSelectedThreadConfig(parsedPayload, {
      fs,
      processObj,
      DatabaseSync: deps.DatabaseSync
    });
    if (threadConfigReconcile && threadConfigReconcile.changed) {
      writeTrace({
        direction: 'proxy_internal',
        action: 'resolve_selected_thread_runtime_config',
        ...threadConfigReconcile
      });
    }
    parsedPayload = rewriteThreadResumeRuntimeConfig(parsedPayload, threadConfigReconcile);
    const staleSteerRewrite = rewriteStaleTurnSteerAsStart(parsedPayload, activeTurnIdsByThreadId);
    if (staleSteerRewrite && staleSteerRewrite.changed) {
      writeTrace({
        direction: 'proxy_internal',
        action: 'rewrite_stale_turn_steer_as_start',
        threadId: staleSteerRewrite.threadId,
        expectedTurnId: staleSteerRewrite.expectedTurnId
      });
      parsedPayload = staleSteerRewrite.payload;
    }
    const finalClientPayload = parsedPayload ? JSON.stringify(parsedPayload) : rewrittenPayload;
    if (
      parsedPayload
      && parsedPayload.method === 'account/read'
      && Object.prototype.hasOwnProperty.call(parsedPayload, 'id')
    ) {
      accountReadResponseIds.add(String(parsedPayload.id));
    }
    if (
      parsedPayload
      && parsedPayload.method === 'getAuthStatus'
      && Object.prototype.hasOwnProperty.call(parsedPayload, 'id')
    ) {
      const params = parsedPayload.params && typeof parsedPayload.params === 'object'
        ? parsedPayload.params
        : {};
      authStatusResponseContexts.set(String(parsedPayload.id), {
        includeToken: params.includeToken !== false,
        refreshToken: params.refreshToken === true
      });
    }
    if (
      parsedPayload
      && parsedPayload.method === 'thread/goal/get'
      && Object.prototype.hasOwnProperty.call(parsedPayload, 'id')
    ) {
      const context = getThreadGoalRequestContext(parsedPayload);
      if (context) threadGoalGetResponseContexts.set(String(parsedPayload.id), context);
    }
    if (
      parsedPayload
      && parsedPayload.method === 'thread/list'
      && Object.prototype.hasOwnProperty.call(parsedPayload, 'id')
    ) {
      const context = getThreadListRequestContext(parsedPayload);
      if (context) threadListResponseContexts.set(String(parsedPayload.id), context);
    }
    rememberThreadResumeRequest(parsedPayload, threadResumeResponseContexts);
    if (threadConfigReconcile && Object.prototype.hasOwnProperty.call(parsedPayload || {}, 'id')) {
      responsePatchContexts.set(String(parsedPayload.id), {
        modelProvider: threadConfigReconcile.currentProvider,
        model: threadConfigReconcile.currentModel
      });
    }
    const fastThreadResponse = buildFastThreadReadResponse(parsedPayload, {
      fs,
      processObj,
      DatabaseSync: deps.DatabaseSync,
      fastReadMinBytes: deps.fastReadMinBytes,
      fastReadTurnLimit: deps.fastReadTurnLimit,
      fastReadInitialBytes: deps.fastReadInitialBytes,
      fastReadMaxBytes: deps.fastReadMaxBytes,
      fastReadMaxCommandOutputChars: deps.fastReadMaxCommandOutputChars,
      staleInProgressAfterMs: deps.staleInProgressAfterMs,
      nowMs: deps.nowMs,
      activeTurnIdsByThreadId
    });
    if (fastThreadResponse) {
      if (Object.prototype.hasOwnProperty.call(parsedPayload || {}, 'id')) {
        responsePatchContexts.delete(String(parsedPayload.id));
      }
      if (parsedPayload && parsedPayload.method === 'thread/resume') {
        const hydrationRequest = buildFastResumeHydrationRequest(
          parsedPayload,
          threadConfigReconcile,
          hydrationRequestSeq += 1
        );
        if (hydrationRequest) {
          const hydrationThreadId = getThreadRequestId(hydrationRequest);
          startHiddenHydration(
            hydrationRequest,
            hydrationThreadId,
            [],
            'hydrate_fast_thread_resume'
          );
        }
      }
      const responsePayload = JSON.stringify({
        id: fastThreadResponse.id,
        result: fastThreadResponse.result
      });
      writeTrace({
        direction: 'proxy_internal',
        action: `fast_${parsedPayload.method.replace('/', '_')}`,
        ...fastThreadResponse.meta
      });
      const fastThreadId = String(fastThreadResponse.meta && fastThreadResponse.meta.threadId || '').trim();
      if (fastThreadId) liveThreadIds.add(fastThreadId);
      processObj.stdout.write(`${responsePayload}\n`);
      return;
    }
    if (shouldHydrateLiveThreadTurnPayload(parsedPayload)) {
      const turnThreadId = getThreadRequestId(parsedPayload);
      const pendingHydration = turnThreadId ? pendingHydrationsByThreadId.get(turnThreadId) : null;
      if (pendingHydration) {
        markTurnStartPending(parsedPayload);
        pendingHydration.pendingPayloads.push(finalClientPayload);
        writeTrace({
          direction: 'proxy_internal',
          action: 'queue_turn_payload_until_thread_hydrated',
          threadId: turnThreadId,
          hydrationResponseId: pendingHydration.responseId,
          method: parsedPayload.method
        });
        return;
      }
      if (turnThreadId && !liveThreadIds.has(turnThreadId)) {
        const stateRowResult = findThreadStateRow(turnThreadId, {
          fs,
          processObj,
          DatabaseSync: deps.DatabaseSync
        });
        if (stateRowResult && stateRowResult.row) {
          const hydrationBasePayload = {
            id: parsedPayload.id,
            method: 'thread/resume',
            params: { threadId: turnThreadId }
          };
          const turnHydrationReconcile = reconcileSelectedThreadConfig(hydrationBasePayload, {
            fs,
            processObj,
            DatabaseSync: deps.DatabaseSync
          });
          const hydrationRequest = buildTurnLiveThreadHydrationRequest(
            parsedPayload,
            turnHydrationReconcile,
            hydrationRequestSeq += 1
          );
          if (startHiddenHydration(
            hydrationRequest,
            turnThreadId,
            [finalClientPayload],
            `hydrate_${String(parsedPayload.method || 'turn').replace(/[^A-Za-z0-9]+/g, '_')}_missing_thread`
          )) {
            markTurnStartPending(parsedPayload);
            writeTrace({
              direction: 'proxy_internal',
              action: 'queue_turn_payload_until_thread_hydrated',
              threadId: turnThreadId,
              reason: 'thread_not_registered_in_proxy',
              method: parsedPayload.method
            });
            return;
          }
        }
      }
    }
    repairMissingOptimizedRolloutPathsForList(parsedPayload);
    if (shouldAggregateThreadList(parsedPayload)) {
      const originalId = parsedPayload.id;
      const firstRequest = buildAggregatePageRequest(
        parsedPayload,
        null,
        originalId,
        AGGREGATE_THREAD_LIST_MAX_ITEMS
      );
      const contextId = String(originalId);
      aggregateContexts.set(contextId, {
        originalId,
        requestTemplate: firstRequest,
        pagesFetched: 0,
        collectedData: [],
        requestedItems: Number(firstRequest.params && firstRequest.params.limit) || 0,
        backwardsCursor: null,
        nextCursor: null
      });
      aggregateRequestIdToContextId.set(String(originalId), contextId);
      const payload = JSON.stringify(firstRequest);
      writeTrace({
        direction: 'client_to_upstream',
        original: line,
        rewritten: payload,
        changed: payload !== line,
        aggregate: true
      });
      traceRemoteJsonRpc(writeTrace, state, 'client_to_upstream', payload, {
        changed: payload !== line,
        aggregate: true
      });
      child.stdin.write(`${payload}\n`);
      return;
    }
    if (line) {
      writeTrace({
        direction: 'client_to_upstream',
        original: line,
        rewritten: finalClientPayload,
        changed: finalClientPayload !== line
      });
      traceRemoteJsonRpc(writeTrace, state, 'client_to_upstream', finalClientPayload, {
        changed: finalClientPayload !== line
      });
    }
    markTurnStartPending(parsedPayload);
    child.stdin.write(`${finalClientPayload}\n`);
  });
  const stdoutPump = createLinePump((line) => {
    const parsedResponse = tryParseJson(line);
    traceRemoteJsonRpc(writeTrace, state, 'upstream_to_client', parsedResponse || line);
    trackTurnLifecycleMessage(parsedResponse);
    const responseId = parsedResponse && Object.prototype.hasOwnProperty.call(parsedResponse, 'id')
      ? String(parsedResponse.id)
      : '';
    if (!responseId && shouldSuppressHydrationNotification(parsedResponse, pendingHydrationsByThreadId)) {
      if (line && state.traceResponses) {
        writeTrace({
          direction: 'upstream_to_proxy',
          payload: line,
          suppressed: true,
          reason: 'hydrate_notification'
        });
      }
      return;
    }
    if (responseId && suppressedResponseIds.has(responseId)) {
      suppressedResponseIds.delete(responseId);
      const hydratedThreadId = hydrationResponseIdToThreadId.get(responseId);
      hydrationResponseIdToThreadId.delete(responseId);
      if (hydratedThreadId) {
        if (parsedResponse && parsedResponse.result && !parsedResponse.error) {
          liveThreadIds.add(hydratedThreadId);
        }
        const pendingHydration = pendingHydrationsByThreadId.get(hydratedThreadId);
        pendingHydrationsByThreadId.delete(hydratedThreadId);
        writeRemoteHydrationSuppressionState(
          fs,
          remoteControlProxy && remoteControlProxy.suppressStateFile,
          pendingHydrationsByThreadId
        );
        for (const pendingPayload of pendingHydration && pendingHydration.pendingPayloads || []) {
          markTurnStartPending(tryParseJson(pendingPayload));
          child.stdin.write(`${pendingPayload}\n`);
        }
        if (pendingHydration && pendingHydration.pendingPayloads.length > 0) {
          writeTrace({
            direction: 'proxy_internal',
            action: 'flush_queued_turn_payload_after_thread_hydrated',
            threadId: hydratedThreadId,
            flushed: pendingHydration.pendingPayloads.length
          });
        }
      }
      if (line && state.traceResponses) {
        writeTrace({
          direction: 'upstream_to_proxy',
          payload: line,
          suppressed: true
        });
      }
      return;
    }
    const aggregateContextId = responseId ? aggregateRequestIdToContextId.get(responseId) : '';
    if (aggregateContextId) {
      const context = aggregateContexts.get(aggregateContextId);
      if (context && parsedResponse && parsedResponse.result && typeof parsedResponse.result === 'object') {
        const result = parsedResponse.result;
        context.pagesFetched += 1;
        context.collectedData = mergeThreadListData(context.collectedData, result.data);
        if (!context.backwardsCursor && result.backwardsCursor) {
          context.backwardsCursor = result.backwardsCursor;
        }
        context.nextCursor = result.nextCursor || null;
        aggregateRequestIdToContextId.delete(responseId);
        const remainingItems = Math.max(
          0,
          AGGREGATE_THREAD_LIST_MAX_ITEMS - context.requestedItems
        );

        if (
          context.pagesFetched < AGGREGATE_THREAD_LIST_MAX_PAGES
          && context.nextCursor
          && remainingItems > 0
        ) {
          const nextRequestId = `aih-aggregate-thread-list:${context.originalId}:${context.pagesFetched + 1}`;
          const nextRequest = buildAggregatePageRequest(
            context.requestTemplate,
            context.nextCursor,
            nextRequestId,
            remainingItems
          );
          context.requestedItems += Number(nextRequest.params && nextRequest.params.limit) || 0;
          aggregateRequestIdToContextId.set(String(nextRequestId), aggregateContextId);
          writeTrace({
            direction: 'proxy_to_upstream',
            rewritten: JSON.stringify(nextRequest),
            aggregate: true,
            page: context.pagesFetched + 1
          });
          child.stdin.write(`${JSON.stringify(nextRequest)}\n`);
          return;
        }

        aggregateContexts.delete(aggregateContextId);
        let finalPayload = JSON.stringify({
          id: context.originalId,
          result: {
            data: context.collectedData,
            nextCursor: context.nextCursor,
            backwardsCursor: context.backwardsCursor
          }
        });
        finalPayload = patchThreadListVisibilityResponse(finalPayload, context.requestTemplate && context.requestTemplate.params
          ? {
            ...getThreadListRequestContext(context.requestTemplate),
            ...context.requestTemplate.params
          }
          : getThreadListRequestContext(context.requestTemplate), {
          fs,
          processObj,
          DatabaseSync: deps.DatabaseSync
        });
        finalPayload = patchThreadTitleFieldsResponse(finalPayload, {
          fs,
          processObj,
          DatabaseSync: deps.DatabaseSync
        });
        if (state.traceResponses) {
          writeTrace({
            direction: 'upstream_to_client',
            payload: finalPayload,
            aggregate: true,
            pagesFetched: context.pagesFetched
          });
        }
        if (state.traceRemoteControl === true) {
          writeTrace({
            direction: 'upstream_to_client',
            remoteControl: true,
            summary: summarizeJsonRpcForTrace(JSON.parse(finalPayload)),
            aggregate: true,
            pagesFetched: context.pagesFetched
          });
        }
        processObj.stdout.write(`${finalPayload}\n`);
        return;
      }
      aggregateRequestIdToContextId.delete(responseId);
      aggregateContexts.delete(aggregateContextId);
    }

    if (line && state.traceResponses) {
      writeTrace({
        direction: 'upstream_to_client',
        payload: line
      });
    }
    const patchContext = responseId ? responsePatchContexts.get(responseId) : null;
    if (responseId) responsePatchContexts.delete(responseId);
    const shouldPatchAccountRead = responseId && accountReadResponseIds.has(responseId);
    if (responseId) accountReadResponseIds.delete(responseId);
    const authStatusContext = responseId ? authStatusResponseContexts.get(responseId) : null;
    if (responseId) authStatusResponseContexts.delete(responseId);
    const threadListContext = responseId ? threadListResponseContexts.get(responseId) : null;
    if (responseId) threadListResponseContexts.delete(responseId);
    const threadGoalGetContext = responseId ? threadGoalGetResponseContexts.get(responseId) : null;
    if (responseId) threadGoalGetResponseContexts.delete(responseId);
    let responsePayload = patchThreadResumeResponseMessage(line, threadResumeResponseContexts);
    responsePayload = patchThreadConfigResponse(responsePayload, patchContext);
    if (shouldPatchAccountRead) {
      responsePayload = patchAccountReadResponse(responsePayload, {
        fs,
        processObj,
        os: deps.os,
        desktopAccountId: state.desktopAccountId
      });
    }
    if (authStatusContext) {
      responsePayload = patchAuthStatusResponse(responsePayload, authStatusContext, {
        fs,
        processObj,
        os: deps.os,
        desktopAccountId: state.desktopAccountId
      });
    }
    if (threadListContext) {
      responsePayload = patchThreadListVisibilityResponse(responsePayload, threadListContext, {
        fs,
        processObj,
        DatabaseSync: deps.DatabaseSync
      });
    }
    if (threadGoalGetContext) {
      responsePayload = patchThreadGoalGetResponse(responsePayload, threadGoalGetContext, {
        fs,
        processObj,
        DatabaseSync: deps.DatabaseSync
      });
    }
    responsePayload = patchThreadTitleFieldsResponse(responsePayload, {
      fs,
      processObj,
      DatabaseSync: deps.DatabaseSync
    });
    processObj.stdout.write(`${responsePayload}\n`);
  });

  processObj.stdin.on('data', (chunk) => stdinPump.write(chunk));
  processObj.stdin.on('end', () => {
    stdinPump.flush();
    if (child.stdin) child.stdin.end();
  });
  child.stdout.on('data', (chunk) => stdoutPump.write(chunk));
  child.stdout.on('end', () => stdoutPump.flush());
  if (child.stderr && typeof child.stderr.on === 'function') {
    const stderrPump = createLinePump((line) => {
      if (state.traceRemoteControl && isRemoteTraceStderrLine(line)) {
        writeTrace({
          direction: 'upstream_stderr',
          remoteControl: true,
          line: sanitizeTraceText(line)
        });
      }
    });
    child.stderr.on('data', (chunk) => {
      try { processObj.stderr.write(chunk); } catch (_error) {}
      stderrPump.write(chunk);
    });
    child.stderr.on('end', () => stderrPump.flush());
  }
  child.on('error', (error) => {
    processObj.stderr.write(`${String((error && error.message) || error || 'proxy_failed')}\n`);
    processObj.exit(1);
  });
  child.once('exit', () => {
    if (sessionNotificationPoller && typeof sessionNotificationPoller.stop === 'function') {
      sessionNotificationPoller.stop();
    }
  });
  forwardExitCode(child, processObj);
  return child;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => runCodexAppServerStdioProxy(process.argv.slice(2)))
    .catch((error) => {
      process.stderr.write(`${String((error && error.message) || error || 'proxy_failed')}\n`);
      process.exit(1);
    });
}

module.exports = {
  AGGREGATE_THREAD_LIST_MAX_ITEMS,
  AGGREGATE_THREAD_LIST_MAX_PAGES,
  FAST_THREAD_READ_MIN_BYTES,
  OPTIMIZED_ROLLOUT_REPAIR_INTERVAL_MS,
  shouldAggregateThreadList,
  buildAggregatePageRequest,
  buildFastResumeHydrationRequest,
  buildTurnStartHydrationRequest,
  buildTurnLiveThreadHydrationRequest,
  buildCodexAppServerSessionEvent,
  buildCodexThreadStatusNotification,
  createCodexAppServerSessionEventPublisher,
  createCodexSessionNotificationPoller,
  buildFastThreadReadResponse,
  buildCodexAppServerRuntimeConfig,
  buildCodexAppServerSpawnEnv,
  buildCodexCliResumeArgs,
  mergeThreadListData,
  prepareCodexAppServerRuntimeHome,
  parseProxyArgs,
  patchAccountReadResponse,
  patchAuthStatusResponse,
  patchThreadTitleFieldsResponse,
  patchThreadConfigResponse,
  parseRecentCodexRolloutTurns,
  readHookState,
  runCodexCliResume,
  runCodexResumeVisibilityRepair,
  repairMissingOptimizedRolloutPaths,
  repairMissingThreadTitleFields,
  patchThreadListVisibilityResponse,
  resolveCanonicalRolloutPath,
  restoreOptimizedRolloutPathInStateDbs,
  reconcileSelectedThreadConfig,
  reconcileResumeThreadProvider,
  rewriteThreadResumeRuntimeConfig,
  sanitizeTraceText,
  shouldSuppressHydrationNotification,
  summarizeJsonRpcForTrace,
  isRemoteTracePayload,
  startRemoteControlProxyProcess,
  runCodexAppServerStdioProxy
};
