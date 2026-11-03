'use strict';

// Bound on-disk log size. Files are trimmed in place because launchd and daemon
// children can keep stdout/stderr descriptors open; renaming those files would
// make the child continue writing an otherwise invisible old generation.

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
// 保留份数（天）。2026-11-01 起默认 10 天：日志按天滚动，超过 10 天的归档直接删。
const DEFAULT_KEEP_DAYS = 10;
// 最大年龄默认跟保留天数一致（10 天）：清扫和滚动必须同一条策略，
// 否则「滚动时才删 10 天、每小时清扫却留 30 天」，闲置日志会多留 20 天。
const DEFAULT_MAX_AGE_MS = DEFAULT_KEEP_DAYS * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// 按天归档的文件名后缀：<base>.<YYYY-MM-DD>
const DATE_SUFFIX_PATTERN = /\.(\d{4}-\d{2}-\d{2})$/;

function resolveMaxBytes(env) {
  const raw = Number((env || {}).AIH_LOG_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
}

function resolveKeepDays(env) {
  const days = Number((env || {}).AIH_LOG_KEEP_DAYS);
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : DEFAULT_KEEP_DAYS;
}

function resolveMaxAgeMs(env, keepDays) {
  const days = Number((env || {}).AIH_LOG_MAX_AGE_DAYS);
  if (Number.isFinite(days) && days > 0) return Math.floor(days * DAY_MS);
  // 没显式覆盖时跟着保留天数走：AIH_LOG_KEEP_DAYS=3 就该 3 天，而不是钉死的 10 天。
  const fallback = Number(keepDays) > 0 ? Math.floor(Number(keepDays)) : DEFAULT_KEEP_DAYS;
  return fallback * DAY_MS;
}

function trimFileToRecentBytes(fs, filePath, maxBytes = DEFAULT_MAX_BYTES) {
  const sizeLimit = Math.max(1, Math.floor(Number(maxBytes) || DEFAULT_MAX_BYTES));
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (_error) {
    return false;
  }
  if (!stats || stats.size <= sizeLimit) return false;

  let fd = null;
  try {
    const start = Math.max(0, stats.size - sizeLimit);
    const buffer = Buffer.allocUnsafe(Math.min(sizeLimit, stats.size));
    fd = fs.openSync(filePath, 'r');
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    fs.closeSync(fd);
    fd = null;

    let retained = buffer.subarray(0, offset);
    if (start > 0) {
      const firstNewline = retained.indexOf(0x0a);
      if (firstNewline >= 0) retained = retained.subarray(firstNewline + 1);
    }
    fs.writeFileSync(filePath, retained);
    return true;
  } catch (_error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_closeError) {}
    }
    try {
      fs.truncateSync(filePath, sizeLimit);
      return true;
    } catch (_truncateError) {
      return false;
    }
  }
}

/** 本地时区的 YYYY-MM-DD（日志按天滚动用本地日期，跨时区不折腾 UTC）。 */
function localDateStamp(ms) {
  const date = new Date(Number(ms) || Date.now());
  const pad = (value) => String(value).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

/**
 * 跨天时把当前日志改名成 <file>.<昨天日期>。
 * 用 mtime 判断"这一天"：文件最后一次写是什么时候，就归到那天，避免整天没日志时生成空归档。
 */
function rotateLogByDay(options = {}) {
  const fsImpl = options.fs;
  const pathImpl = options.path || nodePath;
  const file = String(options.file || "").trim();
  const now = Number(options.now) || Date.now();
  if (!fsImpl || !file) return false;
  let stats = null;
  try { stats = fsImpl.statSync(file); } catch (_error) { return false; }
  if (!stats || !stats.size) return false;
  const fileDay = localDateStamp(stats.mtimeMs);
  const today = localDateStamp(now);
  if (fileDay === today) return false;
  const archived = file + "." + fileDay;
  try {
    if (typeof fsImpl.existsSync === "function" && fsImpl.existsSync(archived)) {
      // 同一天已经有归档（上一次滚动过）：把增量并进去，避免覆盖。
      const previous = fsImpl.readFileSync(archived);
      const current = fsImpl.readFileSync(file);
      fsImpl.writeFileSync(archived, Buffer.concat([previous, current]));
      fsImpl.truncateSync(file, 0);
      return true;
    }
    fsImpl.renameSync(file, archived);
    return true;
  } catch (_error) {
    return false;
  }
}

/** 删除超过 keepDays 的按天归档（<file>.<YYYY-MM-DD>）；返回删除个数。 */
function pruneDatedLogs(options = {}) {
  const fsImpl = options.fs;
  const pathImpl = options.path || nodePath;
  const file = String(options.file || "").trim();
  if (!fsImpl || !file) return 0;
  const dir = pathImpl.dirname(file);
  const base = pathImpl.basename(file);
  const keepDays = Number(options.keepDays) > 0 ? Number(options.keepDays) : DEFAULT_KEEP_DAYS;
  const now = Number(options.now) || Date.now();
  const cutoffDay = localDateStamp(now - keepDays * DAY_MS);
  let removed = 0;
  let entries = [];
  try { entries = fsImpl.readdirSync(dir); } catch (_error) { return 0; }
  for (const name of entries) {
    if (!name.startsWith(base + ".")) continue;
    const match = DATE_SUFFIX_PATTERN.exec(name);
    if (!match) continue;
    if (match[1] >= cutoffDay) continue;
    try { fsImpl.rmSync(pathImpl.join(dir, name), { force: true }); removed += 1; } catch (_error) {}
  }
  return removed;
}
/**
 * Enforce size and age limits across every `*.log` / `*.jsonl` file under
 * `logsDir`. Trimming happens in place so active daemon file descriptors remain
 * attached to the bounded file.
 *
 * @returns {number} number of files trimmed or removed
 */
function sweepAihLogs(fs, path, logsDir, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
  const keepDays = Number(options.keepDays) > 0 ? Math.floor(Number(options.keepDays)) : DEFAULT_KEEP_DAYS;
  const maxAgeMs = Number(options.maxAgeMs) > 0 ? Number(options.maxAgeMs) : keepDays * DAY_MS;
  const now = Number(options.now) || Date.now();
  // 按天归档按「文件名里的日期」判超期，不依赖 mtime：文件停写后不会再触发滚动，
  // 只靠 mtime 会让 10~30 天的归档多留一轮。
  const cutoffDay = localDateStamp(now - keepDays * DAY_MS);
  const pendingDirs = [logsDir];
  let changed = 0;
  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const name = String(entry && entry.name || '');
      const entryPath = path.join(currentDir, name);
      if (entry && typeof entry.isDirectory === 'function' && entry.isDirectory()) {
        pendingDirs.push(entryPath);
        continue;
      }
      // 也覆盖按天归档：<name>.log.<YYYY-MM-DD> / <name>.jsonl.<YYYY-MM-DD> / <name>.log.1
      if (!/\.(log|jsonl)(?:\.1|\.\d{4}-\d{2}-\d{2})?$/i.test(name)) continue;
      const dated = DATE_SUFFIX_PATTERN.exec(name);
      if (dated && dated[1] < cutoffDay) {
        try {
          fs.rmSync(entryPath, { force: true });
          changed += 1;
        } catch (_error) {}
        continue;
      }
      let stats = null;
      try { stats = fs.statSync(entryPath); } catch (_error) {}
      if (stats && now - Number(stats.mtimeMs || 0) > maxAgeMs) {
        try {
          fs.rmSync(entryPath, { force: true });
          changed += 1;
        } catch (_error) {}
        continue;
      }
      if (typeof fs.chmodSync === 'function') {
        try { fs.chmodSync(entryPath, 0o600); } catch (_error) {}
      }
      if (trimFileToRecentBytes(fs, entryPath, maxBytes)) changed += 1;
    }
  }
  return changed;
}

module.exports = {
  DEFAULT_KEEP_DAYS,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_BYTES,
  localDateStamp,
  pruneDatedLogs,
  resolveKeepDays,
  rotateLogByDay,
  resolveMaxBytes,
  resolveMaxAgeMs,
  sweepAihLogs,
  trimFileToRecentBytes
};
