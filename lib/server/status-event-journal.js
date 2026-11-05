'use strict';

const nodePath = require('node:path');

// 真实状态事件日志：Node 把生产上发生过的运行态事件逐条写盘，事后按 accountRef 回放给
// Go oracle 复算，用两边的最终状态判断迁移是否等价。它是「观测」而不是「状态」：
//   1. append 绝不阻塞、绝不抛错 —— 只入内存队列，落盘在 setImmediate 里批量 fs.appendFile；
//   2. 单文件封顶（默认 5MiB），超限把当前文件 rename 成 .1，只保留一份旧档；
//   3. 只有 server.js 的启动路径会 enable —— 回放脚本自己 createAccountStateService 时
//      日志必须保持关闭，否则回放读到的就是回放自己写出来的事件。

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const FILE_NAME = 'status-events.jsonl';
const ARCHIVE_FILE_NAME = 'status-events.jsonl.1';
const REASON_MAX_CHARS = 200;
const EVENT_VERSION = 1;
// 只有这三种 op 能被 Go oracle 回放，别的写进去只会变成噪声。
const SUPPORTED_OPS = new Set(['failure', 'clear', 'runtime_state']);

// 单例：整个进程只允许一个 journal，避免多个写入者各自记字节数导致轮转判断错乱。
let state = null;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function toMillis(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

// reason 可能带整段上游响应体；按「字符」（而不是字节/UTF-16 单元）截断，避免把中文
// 截成半个代理对。日志只用于复算失败原因，前 200 字符足够区分。
function truncateReason(value) {
  const chars = Array.from(String(value == null ? '' : value));
  return chars.length > REASON_MAX_CHARS ? chars.slice(0, REASON_MAX_CHARS).join('') : chars.join('');
}

// 把调用方给的事件整理成契约格式；返回 null 表示这条事件没有回放价值（缺 accountRef /
// provider / kind 等），直接丢弃比写一条 oracle 读不懂的记录更好。
function buildRecord(event) {
  if (!event || typeof event !== 'object') return null;
  const accountRef = normalizeText(event.accountRef);
  const provider = normalizeText(event.provider);
  const op = normalizeText(event.op);
  if (!accountRef || !provider || !SUPPORTED_OPS.has(op)) return null;

  const record = {
    v: EVENT_VERSION,
    atMs: toMillis(event.atMs) || Date.now(),
    accountRef,
    provider,
    op
  };

  if (op === 'failure') {
    const failure = event.failure && typeof event.failure === 'object' ? event.failure : {};
    const kind = normalizeText(failure.kind);
    // 没有 kind 的失败不会被任何策略消费，oracle 也无法据此选分支。
    if (!kind) return null;
    record.failure = {
      kind,
      reason: truncateReason(failure.reason),
      cooldownMs: toMillis(failure.cooldownMs),
      // 只有显式声明的「只能人工复核」才有语义，其它一律 null（与 Node 的
      // routingBlockRecheck 判定保持一致）。
      routingBlockRecheck: failure.routingBlockRecheck === 'manual' ? 'manual' : null
    };
    return record;
  }

  if (op === 'clear') {
    const evidence = normalizeText(event.evidence);
    // 没有证据的清除无法回放：Go 侧要靠 evidence 决定「哪些阻塞该解除」。
    if (!evidence) return null;
    record.evidence = evidence;
    return record;
  }

  // runtime_state 原样记录：null 是「显式清空」，不能被当成缺字段丢掉。
  record.state = event.state === undefined ? null : event.state;
  return record;
}

function payloadFor(lines) {
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// 队列里可能堆了远超一个文件上限的行（进程卡住后恢复）。这里只保留最新的、放得下的
// 那部分：轮转已经把旧档保留在 .1，丢最旧的行与「只留一份旧档」的取舍一致，也不会把
// 一个超大 payload 一次性写爆磁盘。
function fitLatestLines(lines, maxBytes) {
  let totalBytes = 0;
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const size = Buffer.byteLength(lines[i]) + 1;
    if (totalBytes + size > maxBytes) break;
    totalBytes += size;
    start = i;
  }
  return lines.slice(start);
}

function rotate(ctx) {
  // 旧档只留一份：上一次的 .1 直接被本次覆盖。
  try {
    ctx.fs.renameSync(ctx.file, ctx.archive);
  } catch (_error) {
    // 文件还不存在（首轮写入前就超限）时 rename 会失败，属于正常路径。
  }
  ctx.bytes = 0;
}

// 取走当前队列并算好要写的 payload。轮转在写之前做：单文件永远不会超过 maxBytes。
function takePayload(ctx) {
  if (!ctx.queue.length) return null;
  let lines = ctx.queue;
  ctx.queue = [];
  let payload = payloadFor(lines);
  let bytes = Buffer.byteLength(payload);

  if (ctx.bytes + bytes > ctx.maxBytes) rotate(ctx);

  if (bytes > ctx.maxBytes) {
    lines = fitLatestLines(lines, ctx.maxBytes);
    payload = payloadFor(lines);
    bytes = Buffer.byteLength(payload);
  }
  if (!payload) return null;
  return { payload, bytes };
}

function writeAsync(ctx, batch) {
  ctx.writing = true;
  try {
    ctx.fs.appendFile(ctx.file, batch.payload, { encoding: 'utf8', mode: 0o600 }, (error) => {
      ctx.writing = false;
      if (!error) ctx.bytes += batch.bytes;
      // 写失败只丢这一批：日志是诊断输入，为了补写反复重试会拖慢/打爆主流程。
      if (ctx === state && ctx.queue.length) scheduleDrain();
    });
  } catch (_error) {
    ctx.writing = false;
  }
}

function drain(ctx) {
  // ctx 已经不是当前单例（被 disable 或被重新 enable）：旧队列直接丢弃，避免写错目录。
  if (ctx !== state || ctx.writing) return;
  const batch = takePayload(ctx);
  if (!batch) return;
  writeAsync(ctx, batch);
}

function scheduleDrain() {
  const ctx = state;
  if (!ctx || ctx.scheduled) return;
  ctx.scheduled = true;
  setImmediate(() => {
    ctx.scheduled = false;
    drain(ctx);
  });
}

// 同步排空队列：只有 disable() 用 —— 进程退出/测试收尾前给队列最后一次落盘机会。
function writeQueuedSync(ctx) {
  if (!ctx.queue.length || ctx.writing) return false;
  const batch = takePayload(ctx);
  if (!batch) return false;
  try {
    ctx.fs.appendFileSync(ctx.file, batch.payload, { encoding: 'utf8', mode: 0o600 });
    ctx.bytes += batch.bytes;
    return true;
  } catch (_error) {
    return false;
  }
}

// 开启单例日志。重复调用会替换上一份配置（测试用不同临时目录时依赖这个语义）。
// 返回 false 表示目录不可用 —— 调用方应当继续启动，只是没有事件日志。
function enable(options = {}) {
  const fs = options.fs;
  const aiHomeDir = normalizeText(options.aiHomeDir);
  if (!fs || typeof fs.appendFile !== 'function' || !aiHomeDir) return false;
  const maxBytes = Number(options.maxBytes) > 0
    ? Math.floor(Number(options.maxBytes))
    : DEFAULT_MAX_BYTES;
  const dir = nodePath.join(aiHomeDir, 'observability');
  const file = nodePath.join(dir, FILE_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_error) {
    return false;
  }
  let bytes = 0;
  try {
    bytes = Number(fs.statSync(file).size) || 0;
  } catch (_error) {
    // 新文件：从这里重新计数。
  }
  state = {
    fs,
    dir,
    file,
    archive: nodePath.join(dir, ARCHIVE_FILE_NAME),
    maxBytes,
    bytes,
    queue: [],
    scheduled: false,
    writing: false
  };
  return true;
}

function disable() {
  const ctx = state;
  if (!ctx) return false;
  state = null;
  ctx.scheduled = false;
  writeQueuedSync(ctx);
  return true;
}

function isEnabled() {
  return state !== null;
}

// append 是热路径：未启用时连记录对象都不构造（调用方配合 isEnabled() 使用）。
function append(event) {
  if (!state) return false;
  try {
    const record = buildRecord(event);
    if (!record) return false;
    const line = JSON.stringify(record);
    if (typeof line !== 'string') return false;
    state.queue.push(line);
    scheduleDrain();
    return true;
  } catch (_error) {
    return false;
  }
}

// 等待内存队列落盘。只给测试/收尾用：生产路径不应该等日志写完。
function flush() {
  return new Promise((resolve) => {
    const ctx = state;
    if (!ctx) {
      resolve(false);
      return;
    }
    const tick = () => {
      if (ctx !== state) {
        resolve(false);
        return;
      }
      if (!ctx.queue.length && !ctx.writing) {
        resolve(true);
        return;
      }
      drain(ctx);
      setImmediate(tick);
    };
    tick();
  });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  FILE_NAME,
  ARCHIVE_FILE_NAME,
  REASON_MAX_CHARS,
  enable,
  disable,
  isEnabled,
  append,
  flush
};
