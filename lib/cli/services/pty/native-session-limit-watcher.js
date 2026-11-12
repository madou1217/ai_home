'use strict';

// CodeBuddy 家族原生会话的 **结构化** 上游失败观察器（PTY 侧）。
//
// 为什么不只扫 PTY 输出：TUI 会把用户输入原样回显。用户只要在消息里打出
// `429 Credits exhausted …`，输出扫描就会把它当成上游报错并立刻换号——这是
// 2026-11-10 用户实测的误换号。文本本身无法区分「用户说的」和「上游回的」。
//
// 会话 jsonl 是唯一可靠的事实源：上游报错会落在 `providerData.error` 里
// （`status` + `code` + `message`），用户消息只有 `role:"user"`，没有这个结构。
// 本模块只做「增量读文件 → 解析结构化报错 → 回调」，动作仍由 pty-runtime-run 负责。
//
// 观察两类结论：
//   1. 429 限流 / 额度耗尽 → `onLimit`（动作：冷却 + 换号）
//   2. HTTP 403 + code 11140「request illegal」→ `onRestricted`
//      （账号被上游风控限制；动作：标记账号 + 换号。不是限流，重新登录也解决不了）
//      11128 的渠道校验也是「request illegal」，但它是 400、属于请求形态问题，
//      必须按状态码挡掉，不能当成账号限制。
//
// 只支持 CodeBuddy 家族（codebuddy / codebuddycn / workbuddy / workbuddycn）：
// 其余 provider 的会话文件格式不同，仍走原来的 PTY 文本识别（带输入回显抑制）。
//
// 历史行必须挡住：换号后会 `--resume` 同一段会话，文件里还留着上一个账号刚写的
// 报错。若把这段历史当成现场，新进程会立刻再换一次号，形成换号循环。因此只接受
// 写入时刻 >= 本 PTY 启动时刻的记录。

const nodeFs = require('node:fs');
const { isCodebuddyFamilyProvider, resolveCodebuddySessionPath } = require('../../../sessions/session-reader-codebuddy');
const { __private: scannerPrivate } = require('../../../usage/model-usage-scanner');
const { detectRateLimitSignal } = require('./auto-switch-policy');

const DEFAULT_POLL_INTERVAL_MS = 1000;
// 会话文件通常首条消息后才落盘：先密后疏地重试，不设上限——用户可能几分钟后才发第一句。
const RESOLVE_RETRY_MS = 2000;
const RESOLVE_RETRY_MAX_MS = 30 * 1000;
const INITIAL_SCAN_BYTES = 64 * 1024;
// 只认「刚发生」的报错：翻旧会话时不该因为昨天的 credits exhausted 立刻切号。
const FRESH_ERROR_WINDOW_MS = 2 * 60 * 1000;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function readEntryTimestampMs(entry) {
  const raw = entry && entry.timestamp;
  const ms = typeof raw === 'number' ? raw : Date.parse(String(raw || ''));
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

// 上游风控限制账号的业务码（腾讯信封 403 + code 11140，msg 同样是 "request illegal"）。
const CODEBUDDY_ACCOUNT_RESTRICTED_CODE = 11140;

function isAccountRestrictedError(error) {
  if (Number(error && error.status) !== 403) return false;
  if (Number(error && error.code) === CODEBUDDY_ACCOUNT_RESTRICTED_CODE) return true;
  // 真机有只透 msg、不带 code 的形态；403 + 这句文案只来自腾讯信封。
  return /request illegal/i.test(normalizeText(error && error.message));
}

function createNativeSessionLimitWatcher(options = {}) {
  const fs = options.fs || nodeFs;
  const getProvider = typeof options.getProvider === 'function'
    ? options.getProvider
    : () => options.provider;
  const hostHomeDir = normalizeText(options.hostHomeDir);
  const aiHomeDir = normalizeText(options.aiHomeDir);
  const getSessionId = typeof options.getSessionId === 'function' ? options.getSessionId : () => '';
  // 会话 cwd：会话库按项目分目录，同一个项目下可能同时跑着别的会话。逐条校验
  // entry.cwd / entry.sessionId 是防「读到隔壁会话的 429」的最后一道闸。
  const cwd = normalizeText(options.cwd);
  const onLimit = typeof options.onLimit === 'function' ? options.onLimit : () => {};
  // 账号被上游风控限制（403 + 11140）：与限流分开回调——动作不同（标记账号 + 换号）。
  const onRestricted = typeof options.onRestricted === 'function' ? options.onRestricted : () => {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const intervalMs = Math.max(250, Number(options.intervalMs) || DEFAULT_POLL_INTERVAL_MS);
  const readJsonlFromOffset = options.readJsonlFromOffset || scannerPrivate.readJsonlFromOffset;
  const resolveSessionPath = options.resolveSessionPath || resolveCodebuddySessionPath;
  // 本 PTY 的启动时刻：更早写入的报错属于上一轮（换号前的账号），不能当现场。
  const startedAtMs = Number.isFinite(Number(options.startedAtMs))
    ? Number(options.startedAtMs)
    : now();
  // 每次换号后抬到「换号那一刻」：旧账号刚写的 429 还留在同一个会话文件里，
  // 新 PTY 的首次补扫不能把它当成新账号的报错（否则会连环换号）。
  let baselineAtMs = startedAtMs;

  let timer = null;
  let filePath = '';
  let offset = 0;
  let initialScan = true;
  let lastModel = '';
  let lastSeenId = '';
  let resolveAttempts = 0;
  let nextResolveAt = 0;
  let lastStatFailAt = 0;
  let fileReady = false;
  // 文件里出现了「本次运行之后」写入的记录 = 这确实是当前会话的活文件。
  // 只有到这一步才允许文本识别让位：否则可能盯着一份旧会话文件，把真正的
  // 429（写在新文件里）挡在文本兜底之外。
  let liveObserved = false;
  let identityKey = '';
  let resolvedSessionId = '';

  function currentProvider() {
    return normalizeText(getProvider()).toLowerCase();
  }

  function isSupported() {
    return isCodebuddyFamilyProvider(currentProvider());
  }

  function resetFileState() {
    filePath = '';
    offset = 0;
    initialScan = true;
    lastModel = '';
    lastSeenId = '';
    resolveAttempts = 0;
    nextResolveAt = 0;
    lastStatFailAt = 0;
    fileReady = false;
    liveObserved = false;
  }

  function resolveFile() {
    const sessionId = normalizeText(getSessionId());
    const provider = currentProvider();
    if (!sessionId) return '';
    const key = `${provider}|${sessionId}`;
    if (filePath && key === identityKey) return filePath;
    if (key !== identityKey) {
      resetFileState();
      identityKey = key;
    }
    const at = now();
    if (at < nextResolveAt) return '';
    let resolved = '';
    try {
      resolved = normalizeText(resolveSessionPath(provider, sessionId, '', { hostHomeDir, aiHomeDir }));
    } catch (_error) {
      resolved = '';
    }
    if (resolved) {
      filePath = resolved;
      resolvedSessionId = sessionId;
      resolveAttempts = 0;
      nextResolveAt = 0;
      return filePath;
    }
    // 退避：文件还没落盘时不要每 2s 全量扫一遍会话目录（codebuddy 冷启动实测 ~0.8s）。
    const backoffMs = Math.min(
      RESOLVE_RETRY_MS * Math.pow(2, Math.min(resolveAttempts, 4)),
      RESOLVE_RETRY_MAX_MS
    );
    resolveAttempts += 1;
    nextResolveAt = at + backoffMs;
    return '';
  }

  function handleLine(line, initial) {
    let entry;
    try { entry = JSON.parse(line); } catch (_error) { return; }
    if (!entry || typeof entry !== 'object') return;
    // 同一项目下可能同时跑着别的会话：只认这条记录自己声明的归属。
    const entrySessionId = normalizeText(entry.sessionId);
    if (entrySessionId && resolvedSessionId && entrySessionId !== resolvedSessionId) return;
    const entryCwd = normalizeText(entry.cwd);
    if (entryCwd && cwd && entryCwd !== cwd) return;
    const atMs = readEntryTimestampMs(entry);
    // 任何「本次运行之后写入」的记录（包括用户消息）都证明这是当前会话的活文件。
    if (atMs > 0 && atMs >= baselineAtMs) liveObserved = true;
    const data = entry.providerData && typeof entry.providerData === 'object' ? entry.providerData : {};
    const model = normalizeText(data.model);
    if (model) lastModel = model;
    const error = data.error && typeof data.error === 'object' ? data.error : null;
    if (!error) return;
    const restricted = isAccountRestrictedError(error);
    if (!restricted && Number(error.status) !== 429) return;
    const message = normalizeText(error.message);
    if (!message && !restricted) return;
    // 首轮扫到的是历史：只认本 PTY 启动之后写的记录。
    if (initial && !(atMs >= baselineAtMs)) return;
    if (atMs > 0 && atMs < baselineAtMs) return;
    if (atMs > 0 && now() - atMs > FRESH_ERROR_WINDOW_MS) return;
    const id = normalizeText(entry.id || error.requestID || error.requestId);
    if (id && id === lastSeenId) return;
    if (restricted) {
      lastSeenId = id;
      onRestricted({
        message,
        code: Number(error.code) || 0,
        model: lastModel,
        entry,
        atMs
      });
      return;
    }
    const signal = detectRateLimitSignal(message, { nowMs: now() });
    if (!signal) return;
    lastSeenId = id;
    onLimit({ signal, message, model: lastModel, entry, atMs });
  }

  function tick() {
    if (!isSupported()) return false;
    const path = resolveFile();
    if (!path) return false;
    let size = 0;
    try {
      const stat = fs.statSync(path);
      size = stat.size;
      // 会话文件必须在基线之后还被写过：身份探测的兜底可能指到同项目里的另一段
      // 会话，旧文件的 mtime 停在过去——这时不能让它把文本兜底关掉。
      fileReady = Number(stat.mtimeMs) >= baselineAtMs;
    } catch (_error) {
      // 文件被删/被改名（换号后续接的新会话）：过一会儿重新解析，别一直对着死路径。
      fileReady = false;
      const at = now();
      if (!lastStatFailAt) lastStatFailAt = at;
      if (at - lastStatFailAt >= RESOLVE_RETRY_MS) resetFileState();
      return false;
    }
    lastStatFailAt = 0;
    if (size < offset) resetFileState();
    if (size === offset && !initialScan) return false;
    const start = initialScan ? Math.max(0, size - INITIAL_SCAN_BYTES) : offset;
    if (size <= start && !initialScan) return false;
    const wasInitial = initialScan;
    let read;
    try {
      read = readJsonlFromOffset(fs, path, start, (line) => handleLine(line, wasInitial));
    } catch (_error) {
      return false;
    }
    offset = read.hadTrailingLine ? read.trailingLineStart : read.offset;
    initialScan = false;
    return true;
  }

  function start() {
    if (timer || !isSupported()) return false;
    try { tick(); } catch (_error) { /* 首轮失败不阻止定时器启动 */ }
    timer = setInterval(() => {
      try { tick(); } catch (_error) { /* 只影响换号提示，下一轮重试 */ }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
  }

  return {
    start,
    stop,
    tick,
    isSupported,
    // 会话文件已被证明是**活的**（有本次运行之后写入的记录），结构化观测才算生效。
    isObserving: () => fileReady && liveObserved,
    // 换号发生时调用：把基线抬到当前时刻，旧账号的 429 不再触发第二次换号。
    noteSwitch: (atMs = now()) => {
      const at = Number(atMs);
      if (Number.isFinite(at) && at > baselineAtMs) baselineAtMs = at;
    },
    getFilePath: () => filePath
  };
}

module.exports = {
  FRESH_ERROR_WINDOW_MS,
  createNativeSessionLimitWatcher,
  readEntryTimestampMs
};
