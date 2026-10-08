'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createZcodeUsageRefresh } = require('../lib/usage/zcode-usage-refresh');

function harness(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-refresh-'));
  const aiHomeDir = path.join(root, 'aih');
  const database = path.join(root, '.zcode', 'cli', 'db');
  const writers = path.join(aiHomeDir, 'run', 'auth-projections', 'zcode');
  fs.mkdirSync(database, { recursive: true });
  fs.mkdirSync(writers, { recursive: true });
  const timers = new Set(), intervals = new Set(), watches = [], scans = [], updates = [], warnings = [];
  const bus = new EventEmitter();
  const watchFs = Object.create(fs);
  watchFs.watch = (target, options, notify) => {
    const watcher = new EventEmitter();
    watcher.close = () => { watcher.closed = true; };
    watches.push({ target, options, notify, watcher });
    return watcher;
  };
  const service = {
    scan: query => { scans.push(query); return { records: 1 }; },
    getAccountTokenUsageAsync: async () => ({}),
    ...overrides.service
  };
  const refresh = createZcodeUsageRefresh({
    fs: watchFs, hostHomeDir: root, aiHomeDir, sessionEventBus: bus, modelUsageService: service,
    setTimeoutFn(fn, ms) { const timer = { fn, ms }; timers.add(timer); return timer; },
    clearTimeoutFn: timer => timers.delete(timer),
    setIntervalFn(fn) { const timer = { fn }; intervals.add(timer); return timer; },
    clearIntervalFn: timer => intervals.delete(timer),
    onTokenUsageUpdated: (_usage, options) => updates.push(options),
    logWarn: message => warnings.push(message),
    ...overrides.options
  });
  t.after(() => { refresh.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, aiHomeDir, database, writers, timers, intervals, watches, scans, updates, warnings, bus, refresh,
    async tick() {
      const timer = timers.values().next().value;
      assert.ok(timer);
      timers.delete(timer);
      await timer.fn();
      return timer.ms;
    },
    discover() { for (const timer of intervals) timer.fn(); }
  };
}

test('ZCode native database and private owner index share one scan and never react to credential changes', async (t) => {
  const h = harness(t);
  h.refresh.start();
  h.refresh.start();
  assert.equal(h.watches.length, 2);
  assert.equal(h.timers.size, 1);
  await h.tick();
  const database = h.watches.find(watch => watch.target === fs.realpathSync(h.database));
  const writers = h.watches.find(watch => watch.target === fs.realpathSync(h.writers));
  assert.equal(database.options.recursive, false);
  assert.equal(writers.options.recursive, true);
  for (const name of ['credentials.json', 'setting.json', 'logs/client.log']) writers.notify('change', name);
  database.notify('change', 'unrelated.sqlite');
  database.notify('change', '../../outside/db.sqlite');
  h.bus.emit('session', { provider: 'codex', type: 'session:turn-completed' });
  h.bus.emit('session', { provider: 'zcode', type: 'session:turn-started' });
  assert.equal(h.timers.size, 0);
  database.notify('change', Buffer.from('db.sqlite-wal'));
  writers.notify('rename', 'account/.aih-runtime/zcode-model-usage-owners.jsonl');
  h.bus.emit('session', { provider: 'zcode', type: 'session:turn-completed' });
  assert.equal(h.timers.size, 1);
  await h.tick();
  assert.deepEqual(h.scans, [{ provider: 'zcode' }, { provider: 'zcode' }]);
  assert.equal(h.updates.at(-1).provider, 'zcode');
});

test('late ZCode private writer notifications retry an empty native scan and refresh committed usage', async (t) => {
  let records = 1;
  const h = harness(t, { service: { scan: () => ({ records }) } });
  h.refresh.start();
  await h.tick();
  records = 0;
  h.watches[0].notify('change', 'db.sqlite-wal');
  const previous = h.updates.length;
  assert.equal(await h.tick(), 250);
  assert.equal(h.updates.length, previous);
  records = 1;
  h.watches[1].notify('change', 'account/.aih-runtime/zcode-model-usage-owners.jsonl');
  await h.tick();
  assert.equal(h.updates.length, previous + 1);
  assert.equal(h.updates.at(-1).provider, 'zcode');
});

test('ZCode watcher recovers replaced or newly installed roots and shutdown cancels all pending work', async (t) => {
  const h = harness(t);
  fs.rmdirSync(h.database);
  h.refresh.start();
  await h.tick();
  assert.equal(h.watches.length, 1);
  fs.mkdirSync(h.database);
  h.discover();
  assert.equal(h.watches.length, 2);
  const original = h.watches.find(watch => watch.target === fs.realpathSync(h.database));
  fs.renameSync(h.database, h.database + '-old');
  fs.mkdirSync(h.database);
  h.discover();
  assert.equal(original.watcher.closed, true);
  assert.equal(h.watches.length, 3);
  h.watches[2].watcher.emit('error', new Error('watch_lost'));
  assert.equal(h.warnings.length, 1);
  h.discover();
  assert.equal(h.watches.length, 4);
  h.refresh.stop();
  h.watches[3].notify('change', 'db.sqlite');
  assert.equal(h.timers.size, 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.bus.listenerCount('session'), 0);
  assert.ok(h.watches.every(watch => watch.watcher.closed));
});

test('disabled ZCode native refresh performs no scans or watches', (t) => {
  const h = harness(t, { options: { enabled: false } });
  h.refresh.start();
  assert.equal(h.timers.size, 0);
  assert.equal(h.watches.length, 0);
  assert.equal(h.intervals.size, 0);
});

test('existing SQLite and private owner files are watched directly and replaced files are rediscovered', async (t) => {
  const h = harness(t);
  const wal = path.join(h.database, 'db.sqlite-wal');
  const ownerLog = path.join(h.writers, 'account', '.aih-runtime', 'zcode-model-usage-owners.jsonl');
  fs.mkdirSync(path.dirname(ownerLog), { recursive: true });
  fs.writeFileSync(wal, 'existing WAL');
  fs.writeFileSync(ownerLog, '{}\n');
  h.refresh.start();
  await h.tick();
  assert.equal(h.watches.length, 4);
  const original = h.watches.find(watch => watch.target === fs.realpathSync(wal));
  original.notify('change', 'db.sqlite-wal');
  h.watches.find(watch => watch.target === fs.realpathSync(ownerLog)).notify('change', 'zcode-model-usage-owners.jsonl');
  assert.equal(h.timers.size, 1);
  await h.tick();
  fs.renameSync(wal, wal + '-old');
  fs.writeFileSync(wal, 'replacement WAL');
  original.notify('rename', 'db.sqlite-wal');
  assert.equal(original.watcher.closed, true);
  assert.equal(h.watches.length, 5);
});

test('real native SQLite and owner file writes notify usage without a chat request', async (t) => {
  const h = harness(t);
  const db = new DatabaseSync(path.join(h.database, 'db.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE model_usage(id TEXT PRIMARY KEY, total_tokens INTEGER);');
  t.after(() => db.close());
  const ownerLog = path.join(h.writers, 'account', '.aih-runtime', 'zcode-model-usage-owners.jsonl');
  fs.mkdirSync(path.dirname(ownerLog), { recursive: true });
  fs.writeFileSync(ownerLog, '{}\n');
  let scans = 0;
  const updates = [];
  const refresh = createZcodeUsageRefresh({
    fs, hostHomeDir: h.root, aiHomeDir: h.aiHomeDir,
    modelUsageService: { scan: () => { scans += 1; return { records: 1 }; }, getAccountTokenUsage: () => ({}) },
    onTokenUsageUpdated: (_usage, options) => updates.push(options.provider)
  });
  t.after(() => refresh.stop());
  refresh.start();
  const deadline = Date.now() + 5000;
  while (scans === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const initial = scans;
  db.prepare('INSERT INTO model_usage VALUES (?, ?)').run('native-bill', 42);
  while (scans === initial && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(scans > initial, 'native WAL change must refresh billing');
  const previous = scans;
  fs.appendFileSync(ownerLog, '{}\n');
  while (scans === previous && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(scans > previous, 'late private writer change must refresh attribution');
  assert.ok(updates.every(provider => provider === 'zcode'));
});
