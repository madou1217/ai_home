'use strict';

const { resolveAihRunPath, resolveAccountRuntimeDir, resolveAccountCliRuntimeDir } = require('../runtime/aih-storage-layout');
const { CODEBUDDY_CONFIG_DIR_BY_PROVIDER } = require('../sessions/session-reader-codebuddy');
const { stableHash } = require('./model-usage-stable-hash');

const caches = new WeakMap();
const WRITE_TIME_TOLERANCE_MS = 5_000;
const ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}';
const WRITE_LINE = new RegExp(`^\\[([^\\]]+)\\] \\[Info\\] \\[pid=\\d+\\] \\[addHistory\\] START sessionId=(${ID}), storeId=[^,]*, types=\\[([^\\]]*)\\], input=\\[(.*)\\]$`);
const INPUT_ENTRY = new RegExp(`^\\{type: ([A-Za-z_][A-Za-z_-]*), id: (${ID})\\}$`);

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
  const types = match[3].split(',').map((type) => type.trim());
  const entries = match[4].split(/(?<=\}),\s*(?=\{)/).map((entry) => INPUT_ENTRY.exec(entry));
  if (entries.length !== types.length || entries.some((entry, i) => !entry || entry[1] !== types[i])) return [];
  return entries.filter((entry) => entry[1] === 'message')
    .map((entry) => ({ sessionId: match[2], messageId: entry[2], timestampMs: at }));
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
  for (const { root, provider, accountRef, privatePath } of discoverPrivateLogRoots(options)) {
    let days;
    try { days = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const day of days) {
      if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue;
      const directory = path.join(root, day.name);
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

function readNativeLogChanges(old, log, { fs, readJsonlFromOffset }) {
  const stat = fs.statSync(log.filePath);
  const sameFile = old && old.provider === log.provider && old.accountRef === log.accountRef
    && old.stat.dev === stat.dev && old.stat.ino === stat.ino;
  if (sameFile && old.stat.size === stat.size && old.stat.mtimeMs === stat.mtimeMs && old.stat.ctimeMs === stat.ctimeMs) {
    return { entry: old, added: [] };
  }
  const append = sameFile && stat.size > old.stat.size;
  const writes = append ? new Map(old.writes) : new Map();
  const pending = [];
  const read = readJsonlFromOffset(fs, log.filePath, append ? old.offset : 0, (line, offset) => {
    for (const write of parseNativeMessageWrites(line)) pending.push({ ...write, offset });
  });
  const added = pending.filter(write => !(read.hadTrailingLine && write.offset >= read.trailingLineStart));
  for (const write of added) writes.set(`${write.sessionId}:${write.messageId}:${write.timestampMs}`, write);
  return { entry: { ...log, stat, writes, offset: read.hadTrailingLine ? read.trailingLineStart : read.offset }, added };
}

function refreshLogCache(cache, options) {
  const seen = new Set();
  for (const log of discoverPrivateLogs(options)) {
    const { filePath } = log;
    seen.add(filePath);
    try {
      cache.set(filePath, readNativeLogChanges(cache.get(filePath), log, options).entry);
    } catch (_) { cache.delete(filePath); }
  }
  for (const filePath of cache.keys()) if (!seen.has(filePath)) cache.delete(filePath);
}

function createNativeMessageOwnership(options) {
  let cache = caches.get(options.store);
  if (!cache) { cache = new Map(); caches.set(options.store, cache); }
  refreshLogCache(cache, options);
  const sessions = new Map();
  for (const log of cache.values()) {
    for (const write of log.writes.values()) {
      const key = `${log.provider.endsWith('cn') ? 'cn' : 'global'}:${write.sessionId}`;
      let session = sessions.get(key);
      if (!session) { session = { messages: new Map(), evidence: new Set() }; sessions.set(key, session); }
      const matches = session.messages.get(write.messageId) || [];
      matches.push({ provider: log.provider, accountRef: log.accountRef, timestampMs: write.timestampMs });
      session.messages.set(write.messageId, matches);
      session.evidence.add(`${write.messageId}:${write.timestampMs}:${log.provider}:${log.accountRef}`);
    }
  }
  for (const session of sessions.values()) session.fingerprint = stableHash([...session.evidence].sort().join('\n'));
  const findSession = (file) => sessions.get(`${file.provider.endsWith('cn') ? 'cn' : 'global'}:${file.sessionId}`);

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
    // Once a shared session has private writer evidence, session-level user_id
    // cannot identify a different or not-yet-observed message's author.
    if (!matches.size) return { provider: file.provider, accountRef: '' };
    if (matches.size !== 1) return { provider: file.provider, accountRef: '' };
    const owner = matches.values().next().value;
    return { provider: owner.provider, accountRef: owner.accountRef };
  }

  return { resolve, fingerprint: (file) => findSession(file)?.fingerprint || '' };
}

module.exports = { createNativeMessageOwnership, parseNativeMessageWrites,
  discoverPrivateLogRoots, discoverPrivateLogs, readNativeLogChanges };
