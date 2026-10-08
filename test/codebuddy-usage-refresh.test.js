'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { createCodebuddyUsageRefresh } = require('../lib/usage/codebuddy-usage-refresh');
const { createModelUsageService } = require('../lib/usage/model-usage-service');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { credential } = require('./helpers/codebuddy-credential');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');

const SESSION_ID = 'native-shared-session';

function createHarness(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-family-usage-refresh-'));
  const projects = path.join(root, '.workbuddy-ai', 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const bus = new EventEmitter();
  const timers = new Set();
  const intervals = new Set();
  const watches = [];
  const scans = [];
  const queries = [];
  const updates = [];
  const warnings = [];
  const watchFs = Object.create(fs);
  watchFs.watch = (target, options, notify) => {
    const watcher = new EventEmitter();
    watcher.closed = false;
    watcher.close = () => { watcher.closed = true; };
    watches.push({ target, options, notify, watcher });
    return watcher;
  };
  const service = {
    scanCodebuddySessionUsage(provider, id) { scans.push([provider, id]); return { records: 1 }; },
    getAccountTokenUsageAsync: async (query) => { queries.push(query); return {}; },
    ...overrides.service
  };
  const refresh = createCodebuddyUsageRefresh({
    fs: watchFs, hostHomeDir: root, sessionEventBus: bus, modelUsageService: service,
    setTimeoutFn(fn, ms) {
      const timer = { fn, ms, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => timers.delete(timer),
    setIntervalFn(fn) { const timer = { fn, unref() {} }; intervals.add(timer); return timer; },
    clearIntervalFn: (timer) => intervals.delete(timer),
    onTokenUsageUpdated: (usage, options) => updates.push({ usage, options }),
    logWarn: message => warnings.push(message),
    ...overrides.options
  });
  t.after(() => { refresh.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    root, projects, bus, refresh, timers, intervals, watches, scans, queries, updates, warnings,
    complete(provider = 'workbuddy', event = {}) {
      bus.emit('session', { provider, sessionId: SESSION_ID, type: 'session:turn-completed', ...event });
    },
    async tick() {
      const timer = timers.values().next().value;
      assert.ok(timer, 'usage refresh must be pending');
      timers.delete(timer);
      await timer.fn();
      return timer.ms;
    },
    discover() { for (const interval of intervals) interval.fn(); }
  };
}

test('same-region completion hooks scan once and refresh both provider caches', async (t) => {
  const h = createHarness(t);
  h.refresh.start();
  h.refresh.start();
  h.complete('workbuddy');
  h.complete('codebuddy');
  assert.equal(h.timers.size, 1);
  await h.tick();
  assert.deepEqual(h.scans, [['codebuddy', SESSION_ID]]);
  assert.deepEqual(h.updates.map(update => update.options.provider), ['codebuddy', 'workbuddy']);
  assert.equal(h.queries[0].nowMs, h.updates[0].options.generatedAt);
  h.complete('workbuddycn');
  await h.tick();
  assert.deepEqual(h.scans[1], ['codebuddycn', SESSION_ID]);
  assert.deepEqual(h.updates.slice(2).map(update => update.options.provider), ['codebuddycn', 'workbuddycn']);
});

test('native alias roots watch one physical directory and delayed partial JSONL retains its actual account', async (t) => {
  const h = createHarness(t);
  const alias = path.join(h.root, '.codebuddy', 'projects');
  fs.mkdirSync(path.dirname(alias));
  fs.symlinkSync(h.projects, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aiHomeDir = path.join(h.root, 'aih');
  const service = createModelUsageService({ fs, path, hostHomeDir: h.root, aiHomeDir, enableAsyncQueries: false });
  t.after(() => service.close());
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'workbuddy', cliAccountId: '1', identitySeed: 'workbuddy:native-user'
  });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: credential('workbuddy', { uid: 'native-user' }) });
  const db = new DatabaseSync(path.join(h.root, '.workbuddy-ai', 'workbuddy.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run(SESSION_ID, 'native-user');
  db.close();
  h.refresh.stop();
  const refresh = createCodebuddyUsageRefresh({
    fs: { ...fs, watch: (target, options, notify) => {
      const watcher = new EventEmitter();
      watcher.close = () => {};
      h.watches.push({ target, options, notify, watcher });
      return watcher;
    } },
    hostHomeDir: h.root, sessionEventBus: h.bus, modelUsageService: service,
    setTimeoutFn(fn, ms) { const timer = { fn, ms }; h.timers.add(timer); return timer; },
    clearTimeoutFn: timer => h.timers.delete(timer),
    setIntervalFn: () => null, clearIntervalFn: () => {},
    onTokenUsageUpdated: (usage, options) => h.updates.push({ usage, options })
  });
  t.after(() => refresh.stop());
  refresh.start();
  assert.equal(h.watches.length, 1, 'symlink aliases must not duplicate watchers');
  h.complete();
  assert.equal(await h.tick(), 250);
  assert.equal(h.updates.length, 0);

  const file = path.join(h.projects, 'project', `${SESSION_ID}.jsonl`);
  fs.mkdirSync(path.dirname(file));
  const bill = JSON.stringify({ id: 'answer', timestamp: Date.now() - 10, type: 'message', role: 'assistant',
    sessionId: SESSION_ID, providerData: { model: 'glm-5.2', rawUsage: { prompt_tokens: 100, completion_tokens: 20 } } });
  fs.writeFileSync(file, bill.slice(0, 40));
  assert.equal(await h.tick(), 1000);
  assert.equal(h.updates.length, 0);
  fs.appendFileSync(file, bill.slice(40) + '\n');
  assert.equal(await h.tick(), 3000);
  assert.deepEqual(h.updates.map(update => update.options.provider), ['codebuddy', 'workbuddy']);
  assert.equal(h.updates[1].usage[accountRef].total, 120);
  assert.equal(service.getStats({ provider: 'workbuddy' }).totalTokens, 120);
  assert.equal(service.getStats({ provider: 'codebuddy' }).totalTokens, 0);

  h.watches[0].notify('change', `project/${SESSION_ID}.jsonl`);
  for (let i = 0; i < 3; i += 1) await h.tick();
  assert.equal(h.updates.at(-1).usage[accountRef].total, 120, 'duplicate file events must not double bill');
});

test('file watcher ignores unrelated files and session hooks reject unsafe or nonterminal identities', (t) => {
  const h = createHarness(t);
  h.refresh.start();
  const notify = h.watches[0].notify;
  for (const name of [null, 'workbuddy.db', 'session.meta.json', '..jsonl', 'project/.hidden.jsonl']) notify('change', name);
  h.complete('codex');
  h.complete('workbuddy', { sessionId: '../outside' });
  h.complete('workbuddy', { type: 'session:turn-started' });
  notify('change', '../../outside.jsonl');
  assert.equal(h.timers.size, 0);
  notify('change', Buffer.from(`project/${SESSION_ID}.jsonl`));
  assert.equal(h.timers.size, 1);
});

test('a coalesced project-directory event discovers its first bill and root events remain idempotent', async (t) => {
  const h = createHarness(t);
  h.refresh.start();
  const project = path.join(h.projects, 'new-project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, SESSION_ID + '.jsonl'), '{}\n');
  h.watches[0].notify('rename', 'new-project');
  h.watches[0].notify('change', 'projects');
  h.watches[0].notify('change', null);
  assert.equal(h.timers.size, 1);
  await h.tick();
  assert.deepEqual(h.scans, [['codebuddy', SESSION_ID]]);
});

test('discovery adds installed products, closes vanished roots and reopens replaced directories', (t) => {
  const h = createHarness(t);
  h.refresh.start();
  const domestic = path.join(h.root, '.workbuddy', 'projects');
  fs.mkdirSync(domestic, { recursive: true });
  h.discover();
  assert.equal(h.watches.length, 2);
  fs.renameSync(h.projects, h.projects + '-retired');
  fs.mkdirSync(h.projects);
  h.discover();
  assert.equal(h.watches[0].watcher.closed, true);
  assert.equal(h.watches.length, 3);
  fs.rmdirSync(domestic);
  h.discover();
  assert.equal(h.watches[1].watcher.closed, true);
});

test('watch failures warn once and recover on discovery without leaving stale listeners', (t) => {
  let unavailable = true;
  const watchFs = Object.create(fs);
  const watchers = [];
  watchFs.watch = () => {
    if (unavailable) throw new Error('recursive_watch_unavailable');
    const watcher = new EventEmitter();
    watcher.close = () => {};
    watchers.push(watcher);
    return watcher;
  };
  const h = createHarness(t, { options: { fs: watchFs } });
  h.refresh.start();
  h.discover();
  h.discover();
  assert.equal(h.warnings.length, 1);
  unavailable = false;
  h.discover();
  assert.equal(watchers.length, 1);
  watchers[0].emit('error', new Error('watch_lost'));
  h.discover();
  assert.equal(watchers.length, 2);
  assert.equal(h.warnings.length, 2);
  h.refresh.stop();
  watchers[1].emit('error', new Error('after_shutdown'));
  assert.equal(h.warnings.length, 2);
});

test('peer cache failure retries committed bills even when the next scan inserts nothing', async (t) => {
  let scans = 0, queries = 0;
  const h = createHarness(t, { service: {
    scanCodebuddySessionUsage: () => ({ records: scans++ === 0 ? 1 : 0 }),
    getAccountTokenUsageAsync: async () => { if (++queries === 2) throw new Error('peer_query_failed'); return {}; }
  } });
  h.refresh.start();
  h.complete();
  await h.tick();
  assert.equal(h.updates.length, 1);
  assert.equal(h.warnings.length, 1);
  assert.equal(await h.tick(), 1000);
  assert.deepEqual(h.updates.map(update => update.options.provider), ['codebuddy', 'codebuddy', 'workbuddy']);
  assert.equal(h.timers.size, 0);
});

test('disabled refresh creates no watchers and shutdown cancels timers and asynchronous publication', async (t) => {
  const disabled = createHarness(t, { options: { enabled: false } });
  disabled.refresh.start();
  disabled.complete();
  assert.equal(disabled.watches.length, 0);
  assert.equal(disabled.intervals.size, 0);
  let release;
  const h = createHarness(t, { service: {
    getAccountTokenUsageAsync: () => new Promise(resolve => { release = resolve; })
  } });
  h.refresh.start();
  h.complete();
  const pending = h.tick();
  await new Promise(resolve => setImmediate(resolve));
  h.refresh.stop();
  release({});
  await pending;
  h.watches[0].notify('change', `project/${SESSION_ID}.jsonl`);
  assert.equal(h.updates.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.bus.listenerCount('session'), 0);
  assert.ok(h.watches.every(watch => watch.watcher.closed));
});

test('native filesystem JSONL writes trigger refresh without WebUI requests or session hooks', async (t) => {
  const h = createHarness(t);
  const updates = [];
  const refresh = createCodebuddyUsageRefresh({
    fs, hostHomeDir: h.root, modelUsageService: {
      scanCodebuddySessionUsage: () => ({ records: 1 }),
      getAccountTokenUsageAsync: async () => ({})
    },
    onTokenUsageUpdated: (_usage, options) => updates.push(options.provider)
  });
  t.after(() => refresh.stop());
  refresh.start();
  const file = path.join(h.projects, 'project', `${SESSION_ID}.jsonl`);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{}\n');
  const deadline = Date.now() + 10_000;
  while (updates.length < 2 && Date.now() < deadline) {
    // Keep writing as a native CLI does. Recursive FSEvents registration can
    // lag its return value while the full suite creates thousands of directories.
    fs.appendFileSync(file, '{}\n');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(updates.slice(0, 2), ['codebuddy', 'workbuddy']);
});

test('a late private native log write repairs an already scanned unowned bill without touching its JSONL', async t => {
  const h = createHarness(t);
  const aiHomeDir = path.join(h.root, 'aih');
  const service = createModelUsageService({ fs, path, hostHomeDir: h.root, aiHomeDir, enableAsyncQueries: false });
  t.after(() => service.close());
  const accountRef = upsertAccountRef(fs, aiHomeDir, { provider: 'workbuddy', cliAccountId: '1', identitySeed: 'late-writer' });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: credential('workbuddy', { uid: 'native-user' }) });
  const file = path.join(h.projects, 'project', SESSION_ID + '.jsonl');
  fs.mkdirSync(path.dirname(file));
  const at = Date.now();
  fs.writeFileSync(file, JSON.stringify({ id: 'answer', type: 'message', role: 'assistant', timestamp: at,
    sessionId: SESSION_ID, providerData: { model: 'default', rawUsage: { prompt_tokens: 100, completion_tokens: 20 } } }) + '\n');
  assert.equal(service.scanCodebuddySessionUsage('workbuddy', SESSION_ID).records, 1);
  assert.equal(service.getAccountTokenUsage()[accountRef], undefined);
  const log = path.join(resolveAccountRuntimeDir(aiHomeDir, 'workbuddy', accountRef), '.workbuddy-ai', 'logs', '2026-10-07', 'native.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, 'startup\n');
  const updates = [];
  const watched = [];
  const watchFs = Object.create(fs);
  watchFs.watch = (target, options, callback) => {
    watched.push(target);
    return fs.watch(target, options, callback);
  };
  const refresh = createCodebuddyUsageRefresh({ fs: watchFs, path, hostHomeDir: h.root, aiHomeDir, modelUsageService: service,
    onTokenUsageUpdated: (usage, options) => updates.push({ usage, options }) });
  t.after(() => refresh.stop());
  refresh.start();
  assert.ok(watched.includes(log), JSON.stringify(watched));
  // The message is already committed. Only its buffered writer log changes.
  const date = new Date(at), pad = value => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
  fs.appendFileSync(log, `[${stamp}] [Info] [pid=1] [addHistory] START sessionId=${SESSION_ID}, storeId=undefined, types=[message], input=[{type: message, id: answer}]\n`);
  const deadline = Date.now() + 5000;
  while (!updates.some(update => update.usage[accountRef]?.total === 120) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(updates.find(update => update.options.provider === 'workbuddy' && update.usage[accountRef])?.usage[accountRef]?.total,
    120, JSON.stringify(updates));
  assert.equal(service.getStats({ provider: 'workbuddy' }).totalTokens, 120);
});
