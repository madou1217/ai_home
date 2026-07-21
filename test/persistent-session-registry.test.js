const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('../lib/runtime/persistent-session-registry');
const persistentSession = require('../lib/runtime/persistent-session');

const ACCOUNT_REF = 'acct_00000000000000000001';
const ACCOUNT_SOCKET = persistentSession.deriveSocket('claude', ACCOUNT_REF);

function makeAihHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-registry-'));
}

function sampleEntry(overrides = {}) {
  return {
    provider: 'claude',
    runtimeScope: ACCOUNT_REF,
    gateway: false,
    accountRef: ACCOUNT_REF,
    socket: ACCOUNT_SOCKET,
    session: 'p-alpha-abc123',
    cwd: '/work/alpha',
    label: '',
    forwardArgs: [],
    ...overrides
  };
}

test('writeEntry persists one JSON file per (socket, session) and lists back', () => {
  const home = makeAihHome();
  const written = registry.writeEntry(home, sampleEntry(), { now: 1000 });
  assert.ok(written);
  assert.equal(written.createdAt, 1000);
  assert.equal(written.updatedAt, 1000);

  const entries = registry.listEntries(home);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].provider, 'claude');
  assert.equal(entries[0].session, 'p-alpha-abc123');
  assert.equal(entries[0].cwd, '/work/alpha');
  assert.equal(Object.hasOwn(entries[0], 'cliAccountId'), false);

  const file = path.join(registry.registryDir(home), registry.entryFileName(ACCOUNT_SOCKET, 'p-alpha-abc123'));
  assert.ok(fs.existsSync(file));
});

test('writeEntry preserves createdAt across rewrites and clears unrecoverable', () => {
  const home = makeAihHome();
  registry.writeEntry(home, sampleEntry(), { now: 1000 });
  registry.markEntryUnrecoverable(home, ACCOUNT_SOCKET, 'p-alpha-abc123', 'cwd-missing');
  assert.equal(registry.listEntries(home)[0].unrecoverable, 'cwd-missing');

  const rewritten = registry.writeEntry(home, sampleEntry(), { now: 2000 });
  assert.equal(rewritten.createdAt, 1000);
  assert.equal(rewritten.updatedAt, 2000);
  assert.equal(registry.listEntries(home)[0].unrecoverable, '');
});

test('registry preserves the inner supervisor cleanup owner marker', () => {
  const home = makeAihHome();
  registry.writeEntry(home, sampleEntry({ supervisorManaged: true }), { now: 1000 });
  const entry = registry.listEntries(home)[0];
  assert.equal(entry.supervisorManaged, true);
});

test('touchEntry only refreshes updatedAt for existing entries', () => {
  const home = makeAihHome();
  registry.writeEntry(home, sampleEntry(), { now: 1000 });
  assert.equal(registry.touchEntry(home, ACCOUNT_SOCKET, 'p-alpha-abc123', { now: 5000 }), true);
  const entry = registry.listEntries(home)[0];
  assert.equal(entry.createdAt, 1000);
  assert.equal(entry.updatedAt, 5000);
  assert.equal(registry.touchEntry(home, ACCOUNT_SOCKET, 'missing-session', { now: 5000 }), false);
});

test('removeEntry and removeEntriesForSocket clean up files', () => {
  const home = makeAihHome();
  registry.writeEntry(home, sampleEntry(), { now: 1 });
  registry.writeEntry(home, sampleEntry({ session: 'p-alpha-abc123-2' }), { now: 1 });
  const codexSocket = persistentSession.deriveSocket('codex', ACCOUNT_REF);
  registry.writeEntry(home, sampleEntry({ socket: codexSocket, provider: 'codex' }), { now: 1 });

  assert.equal(registry.removeEntry(home, ACCOUNT_SOCKET, 'p-alpha-abc123'), true);
  assert.equal(registry.listEntries(home).length, 2);

  assert.equal(registry.removeEntriesForSocket(home, ACCOUNT_SOCKET), 1);
  const rest = registry.listEntries(home);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].socket, codexSocket);
});

test('rejects unsafe socket/session parts instead of escaping them', () => {
  const home = makeAihHome();
  assert.equal(registry.entryFileName('aih claude', 'x'), '');
  assert.equal(registry.entryFileName(ACCOUNT_SOCKET, '../evil'), '');
  assert.equal(registry.writeEntry(home, sampleEntry({ session: '../evil' })), null);
  assert.equal(registry.listEntries(home).length, 0);
});

test('gateway entries use an explicit runtime scope without accountRef', () => {
  const home = makeAihHome();
  const socket = persistentSession.deriveSocket('codex', persistentSession.GATEWAY_RUNTIME_SCOPE);
  const written = registry.writeEntry(home, sampleEntry({
    provider: 'codex',
    runtimeScope: persistentSession.GATEWAY_RUNTIME_SCOPE,
    gateway: true,
    accountRef: '',
    socket
  }));

  assert.ok(written);
  assert.equal(written.gateway, true);
  assert.equal(written.runtimeScope, 'gateway');
  assert.equal(written.accountRef, '');
  assert.equal(written.socket, 'aih-codex-gateway');
});

test('listEntries skips corrupt files and dotfiles (e.g. the restore lock)', () => {
  const home = makeAihHome();
  registry.writeEntry(home, sampleEntry(), { now: 1 });
  fs.writeFileSync(path.join(registry.registryDir(home), 'broken.json'), '{not json', 'utf8');
  fs.writeFileSync(path.join(registry.registryDir(home), '.restore.lock'), '1 2', 'utf8');
  const entries = registry.listEntries(home);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].session, 'p-alpha-abc123');
});

test('listEntries strict mode fails closed on corrupt registry metadata', () => {
  const home = makeAihHome();
  fs.mkdirSync(registry.registryDir(home), { recursive: true });
  fs.writeFileSync(path.join(registry.registryDir(home), 'broken.json'), '{not json', 'utf8');

  assert.throws(
    () => registry.listEntries(home, { strict: true }),
    SyntaxError
  );
});

test('writeEntry strict mode surfaces registry persistence failures', () => {
  const home = makeAihHome();
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'writeFileSync') {
        return () => {
          const error = new Error('simulated registry write failure');
          error.code = 'EIO';
          throw error;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  assert.throws(
    () => registry.writeEntry(home, sampleEntry(), { fs: failingFs, strict: true }),
    (error) => error && error.code === 'EIO'
  );
});
