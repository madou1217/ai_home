'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RUN_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,160}$/;
const DEFAULT_RUN_RETENTION_DAYS = 14;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 1000;
let lastPruneAt = 0;

function normalizeText(value, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function normalizeLimit(value, fallback = 100) {
  const limit = normalizeCount(value || fallback);
  return Math.max(1, Math.min(500, limit));
}

function safeRunId(value) {
  const runId = normalizeText(value, 160);
  return RUN_ID_PATTERN.test(runId) ? runId : '';
}

function resolveAiHomeDir(options = {}) {
  return normalizeText(options.aiHomeDir || options.ai_home_dir, 2048);
}

function getNativeRunStoreDir(options = {}) {
  const aiHomeDir = resolveAiHomeDir(options);
  if (!aiHomeDir) return '';
  return path.join(aiHomeDir, 'fabric', 'native-runs');
}

function getNativeRunPaths(runId, options = {}) {
  const safeId = safeRunId(runId);
  const dir = getNativeRunStoreDir(options);
  if (!safeId || !dir) return null;
  return {
    dir,
    metaPath: path.join(dir, `${safeId}.json`),
    eventsPath: path.join(dir, `${safeId}.events.jsonl`)
  };
}

function writeJsonAtomic(filePath, payload) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function inferCompleted(meta = {}, events = []) {
  if (meta.completed === true) return true;
  return events.some((event) => {
    const type = normalizeText(event && event.type, 64);
    return type === 'done' || type === 'aborted' || type === 'error';
  });
}

function buildRunMeta(run = {}) {
  return {
    runId: normalizeText(run.runId, 160),
    provider: normalizeText(run.provider, 64),
    accountId: normalizeText(run.accountId, 96),
    sessionId: normalizeText(run.sessionId, 256),
    projectDirName: normalizeText(run.projectDirName, 512),
    projectPath: normalizeText(run.projectPath, 2048),
    startedAt: normalizeCount(run.startedAt),
    updatedAt: normalizeCount(run.updatedAt),
    eventCursor: normalizeCount(run.eventCursor),
    completed: Boolean(run.completed)
  };
}

function persistNativeChatRunEvent(run = {}, event = {}, options = {}) {
  const paths = getNativeRunPaths(run.runId, options);
  if (!paths) return false;
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.appendFileSync(paths.eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
  writeJsonAtomic(paths.metaPath, buildRunMeta(run));
  maybePrunePersistedNativeRuns(options);
  return true;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function readJsonlFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function readPersistedNativeChatRunEvents(runId, options = {}) {
  const paths = getNativeRunPaths(runId, options);
  if (!paths || !fs.existsSync(paths.eventsPath)) return null;
  const meta = readJsonFile(paths.metaPath) || {};
  const allEvents = readJsonlFile(paths.eventsPath)
    .map((event) => ({
      ...event,
      seq: normalizeCount(event && (event.seq || event.cursor)),
      cursor: normalizeCount(event && event.cursor)
    }))
    .filter((event) => event.cursor > 0)
    .sort((left, right) => left.cursor - right.cursor);
  const cursor = normalizeCount(options.cursor);
  const limit = normalizeLimit(options.limit);
  const events = allEvents
    .filter((event) => normalizeCount(event.cursor) > cursor)
    .slice(0, limit);
  const latestCursor = allEvents.reduce((max, event) => Math.max(max, normalizeCount(event.cursor)), 0);
  const completed = inferCompleted(meta, allEvents);
  return {
    runId: normalizeText(meta.runId || runId, 160),
    provider: normalizeText(meta.provider, 64),
    accountId: normalizeText(meta.accountId, 96),
    sessionId: normalizeText(meta.sessionId, 256),
    projectDirName: normalizeText(meta.projectDirName, 512),
    projectPath: normalizeText(meta.projectPath, 2048),
    status: completed ? 'completed' : 'running',
    cursor: Math.max(cursor, latestCursor),
    events,
    truncated: events.length >= limit,
    completed,
    persisted: true
  };
}

function resolveRetentionMs(options = {}) {
  const days = Number(options.retentionDays || options.runRetentionDays);
  const safeDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_RUN_RETENTION_DAYS;
  return Math.max(1, Math.floor(safeDays)) * 24 * 60 * 60 * 1000;
}

function prunePersistedNativeRuns(options = {}) {
  const dir = getNativeRunStoreDir(options);
  if (!dir || !fs.existsSync(dir)) return;
  const maxAgeMs = resolveRetentionMs(options);
  const now = Date.now();
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json') && !entry.endsWith('.events.jsonl')) continue;
    const filePath = path.join(dir, entry);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) fs.unlinkSync(filePath);
    } catch (_error) {}
  }
}

function maybePrunePersistedNativeRuns(options = {}) {
  const now = Date.now();
  const intervalMs = Math.max(1000, Math.floor(Number(options.pruneIntervalMs) || DEFAULT_PRUNE_INTERVAL_MS));
  if (!options.forcePrune && now - lastPruneAt < intervalMs) return false;
  lastPruneAt = now;
  prunePersistedNativeRuns(options);
  return true;
}

module.exports = {
  DEFAULT_RUN_RETENTION_DAYS,
  getNativeRunPaths,
  maybePrunePersistedNativeRuns,
  persistNativeChatRunEvent,
  prunePersistedNativeRuns,
  readPersistedNativeChatRunEvents
};
