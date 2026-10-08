'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { createSessionUsageRefresh, isTerminalSessionEvent } = require('./session-usage-refresh');

const OWNER_LOG_NAME = 'zcode-model-usage-owners.jsonl';
const DATABASE_FILES = new Set(['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm']);

// SQLite and its late private writer index are separate sources. Both notify
// the same bounded refresh state machine; the scanner owns billing/identity.
function createZcodeUsageRefresh(options = {}) {
  const fs = options.fs || nodeFs, path = options.path || nodePath;
  const service = options.modelUsageService;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const watchers = new Map();
  const unavailable = new Set();
  const logWarn = options.logWarn || (() => {});
  let running = false, discoveryTimer = null;
  const refresh = createSessionUsageRefresh({
    ...options, label: 'ZCode',
    enabled: options.enabled !== false && typeof service?.scan === 'function',
    scan: () => service.scan({ provider: 'zcode' }),
    resolveSession: event => event.provider === 'zcode'
      && (event.type === 'session:native-billing-changed' || isTerminalSessionEvent(event))
      ? { provider: 'zcode', sessionId: 'native-billing' } : null
  });

  function notify() {
    if (running) refresh.notify({ provider: 'zcode', type: 'session:native-billing-changed' });
  }

  function warnUnavailable(key) {
    if (unavailable.has(key)) return;
    unavailable.add(key);
    logWarn('ZCode native usage watcher unavailable; periodic reconciliation remains active');
  }

  function watchCandidates() {
    const candidates = [];
    if (options.hostHomeDir) {
      const root = path.join(options.hostHomeDir, '.zcode', 'cli', 'db');
      candidates.push({ key: 'database', root, kind: 'database', recursive: false });
      // Directory notifications do not reliably report existing file writes on
      // macOS. Watch the SQLite files themselves and rediscover them on rename.
      for (const name of DATABASE_FILES) {
        candidates.push({ key: `database:${name}`, root: path.join(root, name), kind: 'file', recursive: false });
      }
    }
    if (options.aiHomeDir) {
      const root = path.join(options.aiHomeDir, 'run', 'auth-projections', 'zcode');
      candidates.push({ key: 'writers', root, kind: 'writers', recursive: true });
      try {
        for (const account of fs.readdirSync(root, { withFileTypes: true })) {
          if (!account.isDirectory()) continue;
          candidates.push({ key: `writer:${account.name}`, kind: 'file', recursive: false,
            root: path.join(root, account.name, '.aih-runtime', OWNER_LOG_NAME) });
        }
      } catch (_) { /* Private projections may not exist until the first launch. */ }
    }
    return candidates;
  }

  function discoverRoots() {
    if (!running) return;
    const roots = new Map();
    for (const candidate of watchCandidates()) {
      try {
        if (fs.lstatSync(candidate.root).isSymbolicLink()) continue;
        const physical = fs.realpathSync(candidate.root);
        const stat = fs.statSync(physical);
        if (candidate.kind === 'file' ? stat.isFile() : stat.isDirectory()) {
          roots.set(candidate.key, { ...candidate, physical, identity: `${stat.dev}:${stat.ino}` });
        }
      } catch (_) { /* An uninstalled native app does not need a directory. */ }
    }
    for (const [key, entry] of watchers) {
      if (roots.get(key)?.identity === entry.identity && roots.get(key)?.physical === entry.physical) continue;
      watchers.delete(key);
      entry.watcher.close();
    }
    for (const [key, root] of roots) {
      if (watchers.has(key)) continue;
      try {
        const watcher = fs.watch(root.physical, { recursive: root.recursive, persistent: false }, (type, filename) => {
          if (!running) return;
          if (root.kind === 'file' || filename == null) {
            notify();
            if (type === 'rename' || filename == null) discoverRoots();
            return;
          }
          const target = path.resolve(root.physical, String(filename));
          const relative = path.relative(root.physical, target);
          if (relative.startsWith('..') || path.isAbsolute(relative)) return;
          const basename = path.basename(target);
          if (root.kind === 'database' ? DATABASE_FILES.has(basename) : basename === OWNER_LOG_NAME) {
            notify();
            discoverRoots();
          }
        });
        watcher.on('error', () => {
          if (!running || watchers.get(key)?.watcher !== watcher) return;
          watchers.delete(key);
          watcher.close();
          warnUnavailable(key);
        });
        watchers.set(key, { ...root, watcher });
        unavailable.delete(key);
        // Catch the first native bill written while this directory was absent.
        notify();
      } catch (_) { warnUnavailable(key); }
    }
  }

  function start() {
    if (running || options.enabled === false || typeof service?.scan !== 'function') return;
    running = true;
    refresh.start();
    discoverRoots();
    discoveryTimer = setIntervalFn(discoverRoots, 30_000);
    if (discoveryTimer && typeof discoveryTimer.unref === 'function') discoveryTimer.unref();
  }

  function stop() {
    running = false;
    if (discoveryTimer != null) clearIntervalFn(discoveryTimer);
    discoveryTimer = null;
    for (const { watcher } of watchers.values()) watcher.close();
    watchers.clear();
    unavailable.clear();
    refresh.stop();
  }

  return { start, stop };
}

module.exports = { createZcodeUsageRefresh };
