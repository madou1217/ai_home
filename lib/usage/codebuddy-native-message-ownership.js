'use strict';

const { resolveAihRunPath, resolveAccountRuntimeDir, resolveAccountCliRuntimeDir } = require('../runtime/aih-storage-layout');
const { CODEBUDDY_CONFIG_DIR_BY_PROVIDER } = require('../sessions/session-reader-codebuddy');
const { stableHash } = require('./model-usage-stable-hash');

// 缓存必须跨 scan 存活：scan 每次都会新建 store，把 store 当 key 会让缓存永远
// 冷启动，每次把全部账号投影的历史日志从 offset 0 重读（2026-11-13 实测单轮
// 217 个文件、3.05GB）。证据只来自日志文件本身，与 DB 连接无关，所以按
// aiHomeDir + hostHomeDir 复用；条目数是路径维度的，用 LRU 上限兜住内存。
const CACHE_LIMIT = 8;
const caches = new Map();
const WRITE_TIME_TOLERANCE_MS = 5_000;
const ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}';
const WRITE_LINE = new RegExp(`^\\[([^\\]]+)\\] \\[Info\\] \\[pid=(\\d+)\\] \\[addHistory\\] START sessionId=(${ID}), storeId=[^,]*, types=\\[([^\\]]*)\\], input=\\[(.*)\\]$`);
const INPUT_ENTRY = new RegExp(`^\\{type: ([A-Za-z_][A-Za-z_-]*), id: (${ID})\\}$`);
// 共享日志（CLI 两支现在统一写 ~/.codebuddy/logs）没有账号目录可归属，只能认进程：
// 同一 pid 的日志行里出现的 userId / x-user-id 就是该进程的账号。addHistory 行也带
// 同一个 pid，于是可以逐条把写入证据对到账号。
const USER_ID_LINE = /^\[[^\]]+\] \[[^\]]+\] \[pid=(\d+)\][^\n]*?["'](?:userId|user_id|x-user-id)["']\s*:\s*["']([^"']+)["']/;

function parseLogTimestamp(value) {
  const iso = /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})$/.exec(value);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4}), (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)\.(\d{1,3})$/.exec(value);
  if (!iso && !us) return 0;
  const year = Number(iso ? iso[1] : us[3]);
  const month = Number(iso ? iso[2] : us[1]);
  const day = Number(iso ? iso[3] : us[2]);
  let hour = Number(iso ? iso[4] : us[4]);
  if (us) {
    if (hour < 1 || hour > 12) return 0;
    hour = hour % 12 + (us[7] === 'PM' ? 12 : 0);
  }
  const minute = Number(iso ? iso[5] : us[5]);
  const second = Number(iso ? iso[6] : us[6]);
  const ms = Number((iso ? iso[7] : us[8]).padEnd(3, '0'));
  const date = new Date(year, month - 1, day, hour, minute, second, ms);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return 0;
  return date.getTime() > 0 ? date.getTime() : 0;
}

function parseNativeMessageWrites(line) {
  const match = WRITE_LINE.exec(line);
  if (!match) return [];
  const at = parseLogTimestamp(match[1]);
  if (!at) return [];
  const pid = match[2];
  const types = match[4].split(',').map((type) => type.trim());
  const entries = match[5].split(/(?<=\}),\s*(?=\{)/).map((entry) => INPUT_ENTRY.exec(entry));
  if (entries.length !== types.length || entries.some((entry, i) => !entry || entry[1] !== types[i])) return [];
  return entries.filter((entry) => entry[1] === 'message')
    .map((entry) => ({ sessionId: match[3], messageId: entry[2], timestampMs: at, pid }));
}

function parseLogPidUser(line) {
  const match = USER_ID_LINE.exec(line);
  return match ? { pid: match[1], userId: match[2] } : null;
}

function discoverPrivateLogRoots({ fs, path, aiHomeDir, accounts }) {
  if (!aiHomeDir) return [];
  const base = resolveAihRunPath(aiHomeDir, 'auth-projections');
  let physicalBase;
  try { physicalBase = fs.realpathSync(base); } catch (_) { return []; }
  // Every path below the canonical projection root must stay at that exact
  // physical location. A host/other-account log symlink is not writer evidence.
  function privatePath(file) {
    try {
      const expected = path.resolve(physicalBase, path.relative(base, file));
      const actual = fs.realpathSync(file);
      return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
    } catch (_) { return false; }
  }
  const roots = [];
  for (const [accountRef, provider] of accounts) {
    const configDir = CODEBUDDY_CONFIG_DIR_BY_PROVIDER[provider];
    if (!configDir) continue;
    const homes = new Set([resolveAccountRuntimeDir(aiHomeDir, provider, accountRef),
      resolveAccountCliRuntimeDir(aiHomeDir, provider, accountRef)]);
    for (const home of homes) {
      const root = path.join(home, configDir, 'logs');
      if (!privatePath(root)) continue;
      roots.push({ root, provider, accountRef, privatePath });
    }
  }
  return roots;
}

function discoverPrivateLogs(options) {
  const { fs, path } = options;
  const logs = [];
  const days = Math.max(1, Number(options.privateLogDays) || PRIVATE_LOG_DAYS);
  for (const { root, provider, accountRef, privatePath } of discoverPrivateLogRoots(options)) {
    for (const dayName of listRecentLogDays(fs, root, days)) {
      const directory = path.join(root, dayName);
      if (!privatePath(directory)) continue;
      let files;
      try { files = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { continue; }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.log')) continue;
        const filePath = path.join(directory, file.name);
        if (privatePath(filePath)) logs.push({ filePath, provider, accountRef });
      }
    }
  }
  return logs;
}

// CLI 两支的 configDir 已切到 ~/.codebuddy（agent view 要求 projects 是真实目录），
// 日志也随之落到共享根。这里只扫最近两天：写入证据只对“当前还在跑的会话”有价值，
// 更早的归属已经落在 model_usage_records 的 previous 里。
const SHARED_LOG_DIR_NAME = '.codebuddy';
const SHARED_LOG_DAYS = 2;
// 私有日志（账号投影下）与共享日志同一口径：只扫最近两天。更早的写入证据只对
// 「尚未落库的消息」有意义，已经落库的归属由 model_usage_records 的 previous 继承；
// 不设窗口时每次冷启动都要重读所有投影的全部历史（2026-11-13 实测 3GB）。
const PRIVATE_LOG_DAYS = 2;

function listRecentLogDays(fs, root, days) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - Math.max(0, Number(days || SHARED_LOG_DAYS) - 1));
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const date = new Date(`${entry.name}T00:00:00`);
    if (!Number.isFinite(date.getTime()) || date < cutoff) continue;
    names.push(entry.name);
  }
  return names.sort();
}

function discoverSharedLogs(options = {}) {
  const { fs, path, hostHomeDir } = options;
  if (!fs || !path || !hostHomeDir) return [];
  const root = path.join(hostHomeDir, SHARED_LOG_DIR_NAME, 'logs');
  const logs = [];
  for (const dayName of listRecentLogDays(fs, root, options.sharedLogDays)) {
    const directory = path.join(root, dayName);
    let files;
    try { files = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { continue; }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.log')) continue;
      logs.push({
        filePath: path.join(directory, file.name),
        provider: '',
        accountRef: '',
        shared: true
      });
    }
  }
  return logs;
}

function readNativeLogChanges(old, log, { fs, readJsonlFromOffset }) {
  const stat = fs.statSync(log.filePath);
  const sameFile = old && old.provider === log.provider && old.accountRef === log.accountRef
    && Boolean(old.shared) === Boolean(log.shared)
    && old.stat.dev === stat.dev && old.stat.ino === stat.ino;
  if (sameFile && old.stat.size === stat.size && old.stat.mtimeMs === stat.mtimeMs && old.stat.ctimeMs === stat.ctimeMs) {
    return { entry: old, added: [] };
  }
  const append = sameFile && stat.size > old.stat.size;
  const writes = append ? new Map(old.writes) : new Map();
  const pids = append && old.pids instanceof Map ? new Map(old.pids) : new Map();
  const pending = [];
  const read = readJsonlFromOffset(fs, log.filePath, append ? old.offset : 0, (line, offset) => {
    const pidUser = parseLogPidUser(line);
    if (pidUser) pids.set(pidUser.pid, pidUser.userId);
    for (const write of parseNativeMessageWrites(line)) pending.push({ ...write, offset });
  });
  const added = pending.filter(write => !(read.hadTrailingLine && write.offset >= read.trailingLineStart));
  for (const write of added) writes.set(`${write.sessionId}:${write.messageId}:${write.timestampMs}`, write);
  return { entry: { ...log, stat, writes, pids, offset: read.hadTrailingLine ? read.trailingLineStart : read.offset }, added };
}

function refreshLogCache(cache, options) {
  const seen = new Set();
  const logs = [...discoverPrivateLogs(options), ...discoverSharedLogs(options)];
  for (const log of logs) {
    const { filePath } = log;
    seen.add(filePath);
    try {
      cache.set(filePath, readNativeLogChanges(cache.get(filePath), log, options).entry);
    } catch (_) { cache.delete(filePath); }
  }
  for (const filePath of cache.keys()) if (!seen.has(filePath)) cache.delete(filePath);
}

function nativeLogCacheKey(options) {
  return `${String(options.aiHomeDir || '')}\u0000${String(options.hostHomeDir || '')}`;
}

function takeNativeLogCache(options) {
  const key = nativeLogCacheKey(options);
  const existing = caches.get(key);
  if (existing) {
    // LRU touch：最近用过的放队尾，超限时从队首淘汰。
    caches.delete(key);
    caches.set(key, existing);
    return existing;
  }
  const cache = new Map();
  caches.set(key, cache);
  while (caches.size > CACHE_LIMIT) {
    const oldest = caches.keys().next().value;
    caches.delete(oldest);
  }
  return cache;
}

function createNativeMessageOwnership(options) {
  const cache = takeNativeLogCache(options);
  refreshLogCache(cache, options);
  const sessions = new Map();
  const resolveLogOwner = (log, write) => {
    if (!log.shared) {
      return log.accountRef ? { provider: log.provider, accountRef: log.accountRef } : null;
    }
    // 共享日志没有账号目录，只能用同一 pid 行里的 userId 反查账号。
    const userId = log.pids instanceof Map ? log.pids.get(String(write.pid)) : '';
    if (!userId || typeof options.resolveLogOwner !== 'function') return null;
    return options.resolveLogOwner({ userId, pid: write.pid }) || null;
  };
  for (const log of cache.values()) {
    for (const write of log.writes.values()) {
      const owner = resolveLogOwner(log, write);
      if (!owner || !owner.accountRef) continue;
      // 共享日志里同一个会话可能被不同站点的账号续写；会话 id 是 UUID，
      // 直接按 id 聚合才能正确判断“多账号写入 → 不猜归属”。
      const key = write.sessionId;
      let session = sessions.get(key);
      if (!session) {
        session = { messages: new Map(), evidence: new Set(), owners: new Set() };
        sessions.set(key, session);
      }
      const matches = session.messages.get(write.messageId) || [];
      matches.push({ provider: owner.provider, accountRef: owner.accountRef, timestampMs: write.timestampMs });
      session.messages.set(write.messageId, matches);
      session.evidence.add(`${write.messageId}:${write.timestampMs}:${owner.provider}:${owner.accountRef}`);
      session.owners.add(`${owner.provider}:${owner.accountRef}`);
    }
  }
  for (const session of sessions.values()) {
    session.fingerprint = stableHash([...session.evidence].sort().join('\n'));
    // 会话级唯一写入者：同一会话所有 addHistory 证据都指向同一个账号时，没被日志
    // 覆盖到的消息（工具回合、旧格式条目）也可以安全继承这个归属；多账号共享会话
    // 仍然保持空归属，绝不猜。
    session.owner = session.owners.size === 1 ? [...session.owners][0] : '';
  }
  // 同族两个站点的 projects 可能是同一份物理存储（或共享日志）：写入证据按
  // sessionId 聚合，不再按地区分桶。
  const findSession = (file) => sessions.get(String(file.sessionId)) || null;

  function parseOwner(value) {
    const text = String(value || '');
    const index = text.indexOf(':');
    if (index <= 0) return null;
    return { provider: text.slice(0, index), accountRef: text.slice(index + 1) };
  }

  function resolve(file, messageId, timestampMs) {
    const session = findSession(file);
    if (!session) return null;
    const candidates = session.messages.get(messageId) || [];
    const matches = new Map();
    for (const candidate of candidates) {
      // Importing/replaying an old message is not a new bill for its importer.
      if (Math.abs(candidate.timestampMs - timestampMs) <= WRITE_TIME_TOLERANCE_MS) {
        matches.set(`${candidate.provider}:${candidate.accountRef}`, candidate);
      }
    }
    // 没有消息级证据时，退回会话级唯一写入者；共享会话（多个账号都写过）仍返回空。
    if (!matches.size) {
      const owner = parseOwner(session.owner);
      return owner || { provider: file.provider, accountRef: '' };
    }
    if (matches.size !== 1) return { provider: file.provider, accountRef: '' };
    const owner = matches.values().next().value;
    return { provider: owner.provider, accountRef: owner.accountRef };
  }

  return {
    resolve,
    // 会话级唯一写入者（没有则 null）；供用量归属在消息级证据缺失时回退。
    sessionOwner: (file) => parseOwner(findSession(file)?.owner),
    fingerprint: (file) => findSession(file)?.fingerprint || ''
  };
}

module.exports = { createNativeMessageOwnership, parseNativeMessageWrites,
  parseLogPidUser, discoverPrivateLogRoots, discoverPrivateLogs, discoverSharedLogs,
  readNativeLogChanges };
