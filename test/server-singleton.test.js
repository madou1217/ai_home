'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { acquireServerInstanceLock, findPortHolderHost, __private } = require('../lib/server/server-singleton');

function fakeFs(initial) {
  const files = new Map(Object.entries(initial || {}));
  return {
    files,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    writeFileSync: (p, v) => files.set(p, String(v)),
    unlinkSync: (p) => { files.delete(p); }
  };
}

function fakeProc(pid, livePids) {
  const live = new Set(livePids || []);
  const handlers = {};
  return {
    pid,
    env: {},
    kill: (p, _sig) => { if (!live.has(p)) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; } return true; },
    once: (event, fn) => { handlers[event] = fn; },
    __fire: (event) => { if (handlers[event]) handlers[event](); }
  };
}

async function withListener(host, port, fn) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  try { await fn(server.address().port); }
  finally { await new Promise((r) => server.close(r)); }
}

test('refuses when the pidfile points at a live foreign instance', async () => {
  const fs = fakeFs({ '/home/server.pid': '4242' });
  const processObj = fakeProc(9001, [4242]); // 4242 alive, we are 9001
  const result = await acquireServerInstanceLock({ fs, processObj, pidFile: '/home/server.pid', host: '127.0.0.1', port: 0 });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'already_running');
  assert.strictEqual(result.pid, 4242);
});

test('treats a stale pidfile (dead pid) as free and claims the lock', async () => {
  const fs = fakeFs({ '/home/server.pid': '4242' }); // 4242 not in live set
  const processObj = fakeProc(9001, []);
  // port 0 => probe binds an ephemeral port, always free
  const result = await acquireServerInstanceLock({ fs, processObj, pidFile: '/home/server.pid', host: '127.0.0.1', port: 0 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(fs.files.get('/home/server.pid'), '9001', 'claimed with our pid');

  processObj.__fire('exit');
  assert.strictEqual(fs.files.has('/home/server.pid'), false, 'pidfile removed on exit');
});

test('detects a holder bound on a different scope (0.0.0.0 vs 127.0.0.1)', async () => {
  await withListener('0.0.0.0', 0, async (port) => {
    // Ask as if we intend to bind 127.0.0.1 — the wildcard holder must still be found.
    const holder = await findPortHolderHost('127.0.0.1', port);
    assert.ok(holder, 'a wildcard holder is detected even when we target loopback');
  });
});

test('reports a free port as free', async () => {
  const holder = await findPortHolderHost('127.0.0.1', 0);
  assert.strictEqual(holder, null);
});

test('acquire refuses when the port is already held', async () => {
  await withListener('127.0.0.1', 0, async (port) => {
    const fs = fakeFs({});
    const processObj = fakeProc(9001, []);
    const result = await acquireServerInstanceLock({ fs, processObj, pidFile: '/home/server.pid', host: '127.0.0.1', port });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'port_in_use');
  });
});

test('isProcessAlive treats EPERM as alive', () => {
  const proc = { kill: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } };
  assert.strictEqual(__private.isProcessAlive(proc, 123), true);
});
