'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const {
  createQoderCliWarmPool,
  DEFAULT_IDLE_TTL_MS,
  DEFAULT_MAX_ENTRIES
} = require('../lib/server/qoder-cli-warm-pool');

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    written: [],
    write(line) {
      this.written.push(line);
    },
    end() {
      this.ended = true;
    }
  };
  child.killed = [];
  child.kill = (signal) => {
    child.killed.push(signal || 'SIGTERM');
  };
  return child;
}

function emitJson(child, payload) {
  child.stdout.emit('data', Buffer.from(`${JSON.stringify(payload)}\n`));
}

function createHarness(options = {}) {
  const children = [];
  let clock = 1000;
  const spawnCalls = [];
  const pool = createQoderCliWarmPool({
    spawn: (cliPath, args, spawnOptions) => {
      spawnCalls.push({ cliPath, args, spawnOptions });
      const child = createFakeChild();
      children.push(child);
      return child;
    },
    now: () => clock,
    idleTtlMs: options.idleTtlMs,
    maxEntries: options.maxEntries,
    killGraceMs: 0
  });
  return {
    pool,
    children,
    spawnCalls,
    advance(ms) { clock += ms; },
    now: () => clock
  };
}

const SPEC = {
  cliPath: '/tmp/qodercli',
  args: ['--print'],
  env: {},
  cwd: '/tmp',
  historyHash: 'h1'
};

test('warm pool reuses an idle entry only when historyHash matches', async () => {
  const harness = createHarness();
  const first = harness.pool.acquire('k', SPEC);
  assert.ok(first);
  const turn = harness.pool.sendTurn(first, {
    input: 'first',
    onLine() {}
  });
  emitJson(harness.children[0], { type: 'result' });
  await turn;
  assert.equal(first.state, 'idle');

  const reused = harness.pool.acquire('k', { ...SPEC, historyHash: 'h1' });
  assert.equal(reused, first);
  assert.equal(harness.spawnCalls.length, 1);

  const replaced = harness.pool.acquire('k', { ...SPEC, historyHash: 'h2' });
  assert.notEqual(replaced, first);
  assert.equal(harness.spawnCalls.length, 2);
  assert.deepEqual(harness.children[0].killed, ['SIGTERM']);
});

test('warm pool never kills a busy entry to serve a concurrent turn', async () => {
  const harness = createHarness();
  const entry = harness.pool.acquire('k', SPEC);
  const turn = harness.pool.sendTurn(entry, { input: 'a', onLine() {} });
  assert.equal(harness.pool.acquire('k', { ...SPEC, historyHash: 'h1' }), null);
  assert.deepEqual(harness.children[0].killed, []);
  emitJson(harness.children[0], { type: 'result' });
  await turn;
});

test('warm pool rejects an aborted turn and discards the child', async () => {
  const harness = createHarness();
  const entry = harness.pool.acquire('k', SPEC);
  const controller = new AbortController();
  const turn = harness.pool.sendTurn(entry, {
    input: 'a',
    onLine() {},
    signal: controller.signal
  });
  controller.abort();
  await assert.rejects(turn, (error) => error.code === 'qoder_cli_aborted');
  assert.equal(harness.pool.get('k'), null);
  assert.deepEqual(harness.children[0].killed, ['SIGTERM']);
});

test('warm pool rejects the pending turn when the child exits', async () => {
  const harness = createHarness();
  const entry = harness.pool.acquire('k', SPEC);
  const turn = harness.pool.sendTurn(entry, { input: 'a', onLine() {} });
  harness.children[0].stderr.emit('data', Buffer.from('boom'));
  harness.children[0].emit('close', 1);
  await assert.rejects(turn, (error) => error.code === 'qoder_cli_warm_exit' && /boom/.test(error.message));
  assert.equal(harness.pool.get('k'), null);
});

test('warm pool prunes idle entries after the TTL', async () => {
  const harness = createHarness({ idleTtlMs: 1000 });
  const entry = harness.pool.acquire('k', SPEC);
  const turn = harness.pool.sendTurn(entry, { input: 'a', onLine() {} });
  emitJson(harness.children[0], { type: 'result' });
  await turn;
  harness.advance(1001);
  harness.pool.prune();
  assert.equal(harness.pool.get('k'), null);
  assert.deepEqual(harness.children[0].killed, ['SIGTERM']);
});

test('warm pool evicts the least recently used idle entry at capacity', async () => {
  const harness = createHarness({ maxEntries: 2 });
  const first = harness.pool.acquire('a', { ...SPEC, historyHash: 'a' });
  const firstTurn = harness.pool.sendTurn(first, { input: 'x', onLine() {} });
  emitJson(harness.children[0], { type: 'result' });
  await firstTurn;
  const second = harness.pool.acquire('b', { ...SPEC, historyHash: 'b' });
  const secondTurn = harness.pool.sendTurn(second, { input: 'y', onLine() {} });
  emitJson(harness.children[1], { type: 'result' });
  await secondTurn;

  const third = harness.pool.acquire('c', { ...SPEC, historyHash: 'c' });
  assert.ok(third);
  assert.equal(harness.pool.get('a'), null);
  assert.ok(harness.pool.get('b'));
  assert.deepEqual(harness.children[0].killed, ['SIGTERM']);
});

test('warm pool returns null when spawn throws so the caller can fall back to cold start', () => {
  const pool = createQoderCliWarmPool({
    spawn: () => { throw new Error('EINVAL'); },
    killGraceMs: 0
  });
  assert.equal(pool.acquire('k', SPEC), null);
  assert.equal(pool.stats().size, 0);
});

test('warm pool forwards the shell flag to spawn', () => {
  const harness = createHarness();
  const entry = harness.pool.acquire('k', { ...SPEC, shell: true });
  assert.ok(entry);
  assert.equal(harness.spawnCalls[0].spawnOptions.shell, true);
  assert.equal(harness.pool.acquire('other', SPEC).spec.shell, undefined);
});

test('warm pool default limits are explicit', () => {
  assert.equal(DEFAULT_IDLE_TTL_MS, 5 * 60 * 1000);
  assert.equal(DEFAULT_MAX_ENTRIES, 8);
});
