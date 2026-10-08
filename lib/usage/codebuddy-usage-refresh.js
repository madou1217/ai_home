'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { CODEBUDDY_CONFIG_DIR_BY_PROVIDER, CODEBUDDY_FAMILY_PROVIDERS, isCodebuddyFamilyProvider } = require('../sessions/session-reader-codebuddy');
const { sameRegion } = require('./codebuddy-usage-ownership');
const { isCodebuddySessionId } = require('./codebuddy-model-usage-scanner');
const { createSessionUsageRefresh, isTerminalSessionEvent } = require('./session-usage-refresh');
const { discoverCodebuddyIdeRoots, discoverCodebuddyIdeSessions } = require('../sessions/codebuddy-ide-store');
const { readNodeAccounts } = require('../account/go-bridge/node-account-reader');
const { discoverPrivateLogRoots, discoverPrivateLogs, readNativeLogChanges } = require('./codebuddy-native-message-ownership');
const { __private: { readJsonlFromOffset } } = require('./model-usage-scanner');

function createCodebuddyUsageRefresh(options = {}) {
  const fs = options.fs || nodeFs, path = options.path || nodePath;
  const service = options.modelUsageService;
  const watchers = new Map();
  const logCursors = new Map();
  const unavailableRoots = new Set();
  const logWarn = options.logWarn || (() => {});
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  let timer, running = false;
  const refresh = createSessionUsageRefresh({
    ...options, label: 'CodeBuddy',
    enabled: options.enabled !== false && typeof service?.scanCodebuddySessionUsage === 'function',
    scan: entry => entry.sessionId === 'native-billing'
      ? service.scan({ provider: entry.provider })
      : service.scanCodebuddySessionUsage(entry.provider, entry.sessionId),
    resolveSession: event => {
      const writerChanged = event.type === 'session:native-writer-changed';
      if (!isCodebuddyFamilyProvider(event.provider) || !writerChanged && !isCodebuddySessionId(event.sessionId)
        || !(writerChanged || isTerminalSessionEvent(event) || event.type === 'session:file-changed')) return null;
      // Same-region products share native bills; scan once and refresh both views.
      const provider = event.provider.endsWith('cn') ? 'codebuddycn' : 'codebuddy';
      return { provider, sessionId: writerChanged ? 'native-billing' : event.sessionId,
        usageProviders: CODEBUDDY_FAMILY_PROVIDERS.filter(peer => sameRegion(provider, peer)) };
    }
  });

  function warnUnavailable(root) {
    if (unavailableRoots.has(root)) return;
    unavailableRoots.add(root);
    logWarn('CodeBuddy native usage watcher unavailable; periodic reconciliation remains active');
  }

  function notifySession(provider, filename) {
    const name = path.basename(String(filename));
    if (!name.endsWith('.jsonl') || !isCodebuddySessionId(name.slice(0, -6))) return;
    refresh.notify({ provider, sessionId: name.slice(0, -6), type: 'session:file-changed' });
  }

  function notifyFiles(provider, root, filename) {
    if (!running) return;
    let target = filename ? path.resolve(root, String(filename)) : root;
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return;
    if (filename && String(filename).endsWith('.jsonl')) {
      notifySession(provider, filename);
      return;
    }
    try {
      if (String(filename) === path.basename(root) && !fs.existsSync(target)) target = root;
      if (!fs.statSync(target).isDirectory()) return;
      // FSEvents may report only a new project directory when the CLI creates
      // its directory and first bill together, before recursive watching catches up.
      // Root-only notifications carry no session identity. Do not enqueue all
      // historical sessions at startup; periodic reconciliation covers this case.
      if (target !== root && path.dirname(target) === root) {
        for (const name of fs.readdirSync(target)) notifySession(provider, name);
      }
    } catch (_) { /* Renamed or removed projects are reconciled by the periodic scan. */ }
  }

  function watchRoots() {
    if (!running || !options.hostHomeDir) return;
    const roots = new Map();
    for (const [provider, dir] of Object.entries(CODEBUDDY_CONFIG_DIR_BY_PROVIDER)) {
      const root = path.join(options.hostHomeDir, dir, 'projects');
      try {
        const physical = fs.realpathSync(root);
        const stat = fs.statSync(physical);
        if (stat.isDirectory() && !roots.has(physical)) {
          roots.set(physical, { provider, kind: 'jsonl', recursive: true, identity: `${stat.dev}:${stat.ino}` });
        }
      } catch (_) { /* Absent products do not need directories or watchers. */ }
    }
    const ideOptions = { fs, path, hostHomeDir: options.hostHomeDir, aiHomeDir: options.aiHomeDir };
    let accounts = new Map();
    if (options.aiHomeDir) {
      try {
        accounts = new Map(readNodeAccounts(options.aiHomeDir, { fs }).accounts
          .filter(account => isCodebuddyFamilyProvider(account.provider))
          .map(account => [account.accountRef, account.provider]));
      } catch (_) { /* Incomplete account stores are retried on discovery. */ }
    }
    const writerOptions = { fs, path, aiHomeDir: options.aiHomeDir, accounts };
    for (const entry of discoverPrivateLogRoots(writerOptions)) {
      try {
        const stat = fs.statSync(entry.root);
        roots.set(entry.root, { ...entry, kind: 'writer-root', recursive: true, identity: `${stat.dev}:${stat.ino}` });
      } catch (_) { /* A native client may be creating its log directory. */ }
    }
    for (const log of discoverPrivateLogs(writerOptions)) {
      try {
        const stat = fs.statSync(log.filePath);
        roots.set(log.filePath, { ...log, kind: 'writer-log', recursive: false, identity: `${stat.dev}:${stat.ino}` });
      } catch (_) { /* A replaced log is rediscovered later. */ }
    }
    for (const source of discoverCodebuddyIdeRoots(ideOptions)) {
      try {
        const physical = fs.realpathSync(source.root), stat = fs.statSync(physical);
        roots.set(physical, { provider: source.provider, kind: 'ide-root', recursive: true, identity: `${stat.dev}:${stat.ino}` });
      } catch (_) { /* The native client may replace a history root during discovery. */ }
    }
    for (const session of discoverCodebuddyIdeSessions(ideOptions)) {
      try {
        const physical = fs.realpathSync(session.indexPath), stat = fs.statSync(physical);
        roots.set(physical, { provider: session.provider, sessionId: session.sessionId,
          kind: 'ide-index', recursive: false, identity: `${stat.dev}:${stat.ino}` });
      } catch (_) { /* An incomplete or atomically replaced index is rediscovered. */ }
    }
    for (const [physical, entry] of watchers) {
      if (roots.get(physical)?.identity === entry.identity) continue;
      watchers.delete(physical);
      entry.watcher.close();
      logCursors.delete(physical);
    }
    for (const [physical, { provider, accountRef, identity, kind, recursive, sessionId }] of roots) {
      if (watchers.has(physical)) {
        if (kind === 'writer-log') notifyWriter(physical, provider, accountRef);
        continue;
      }
      try {
        const watcher = fs.watch(physical, { recursive, persistent: false }, (type, filename) => {
          if (!running) return;
          if (kind === 'jsonl') {
            notifyFiles(provider, physical, filename);
            if (type === 'rename') watchRoots();
            return;
          }
          if (kind === 'writer-log') {
            notifyWriter(physical, provider, accountRef);
            if (type === 'rename') watchRoots();
            return;
          }
          if (kind === 'writer-root') {
            if (filename != null) {
              const target = path.resolve(physical, String(filename));
              const relative = path.relative(physical, target);
              if (!relative.startsWith('..') && !path.isAbsolute(relative) && target.endsWith('.log')) {
                try {
                  if (fs.realpathSync(target) === target && fs.lstatSync(target).isFile()) notifyWriter(target, provider, accountRef);
                } catch (_) { /* The log may already be rotated or removed. */ }
              }
            }
            if (filename == null || type === 'rename') watchRoots();
            return;
          }
          if (kind === 'ide-index') {
            refresh.notify({ provider, sessionId, type: 'session:file-changed' });
            if (type === 'rename') watchRoots();
            return;
          }
          const relative = filename == null ? '' : String(filename);
          if (!relative || path.basename(relative) === 'index.json' || !path.extname(relative)) watchRoots();
        });
        watcher.on('error', () => {
          if (!running || watchers.get(physical)?.watcher !== watcher) return;
          watchers.delete(physical);
          logCursors.delete(physical);
          watcher.close();
          warnUnavailable(physical);
        });
        watchers.set(physical, { watcher, identity });
        unavailableRoots.delete(physical);
        if (kind === 'ide-index') refresh.notify({ provider, sessionId, type: 'session:file-changed' });
        if (kind === 'writer-log') notifyWriter(physical, provider, accountRef);
      } catch (_) {
        warnUnavailable(physical);
      }
    }
  }

  function notifyWriter(filePath, provider, accountRef) {
    try {
      const previous = logCursors.get(filePath);
      const { entry, added } = readNativeLogChanges(previous, { filePath, provider, accountRef },
        { fs, readJsonlFromOffset });
      logCursors.set(filePath, entry);
      // Startup logs can reference thousands of historical sessions. Reconcile
      // the region once instead of queuing a token query for every old session.
      // Include empty logs: FSEvents registration can lag fs.watch(), so the
      // initial reconciliation must also catch an immediately buffered write.
      if (!previous) {
        refresh.notify({ provider, type: 'session:native-writer-changed' });
        return;
      }
      for (const sessionId of new Set(added.map(write => write.sessionId))) {
        refresh.notify({ provider, sessionId, type: 'session:file-changed' });
      }
    } catch (_) { /* Partial, rotated and removed logs are rediscovered. */ }
  }

  function start() {
    if (running || options.enabled === false || typeof service?.scanCodebuddySessionUsage !== 'function') return;
    running = true;
    refresh.start();
    watchRoots();
    // Watch newly installed products too, without creating their native directories.
    timer = setIntervalFn(watchRoots, 30_000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    running = false;
    if (timer != null) clearIntervalFn(timer);
    timer = null;
    for (const { watcher } of watchers.values()) watcher.close();
    watchers.clear();
    logCursors.clear();
    unavailableRoots.clear();
    refresh.stop();
  }

  return { start, stop };
}

module.exports = { createCodebuddyUsageRefresh };
