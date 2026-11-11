'use strict';

// 回归守卫（2026-11-06）：CodeBuddy CLI 的 configDir 切到 ~/.codebuddy 之后，
// 原生会话日志也跟着搬出账号投影（~/.codebuddy/logs）。用量归属原先只认
// “账号投影里的私有日志”，新会话会退化成未归属。这里钉住两条来源：
//   - 私有日志：目录即账号，行为不变；
//   - 共享日志：按 addHistory 行的 pid ↔ 同 pid 的 userId 反查账号，
//     同一会话多账号写入时保持空归属（不猜）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createNativeMessageOwnership,
  parseLogPidUser
} = require('../lib/usage/codebuddy-native-message-ownership');
const { __private: { readJsonlFromOffset } } = require('../lib/usage/model-usage-scanner');
const { readRegistrySessionOwners } = require('../lib/usage/codebuddy-usage-ownership');
const { writeEntry } = require('../lib/runtime/persistent-session-registry');

const TS = '[11/6/2026, 8:40:53 PM.727]';
const TS_MS = new Date(2026, 10, 6, 20, 40, 53, 727).getTime();

function localDayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function userLine(pid, userId) {
  return `${TS} [Info] [pid=${pid}] [CloudProductManager] headers: {"userId":"${userId}"}`;
}

function writeLine(pid, sessionId, messageId) {
  return `${TS} [Info] [pid=${pid}] [addHistory] START sessionId=${sessionId}, storeId=undefined, types=[message], input=[{type: message, id: ${messageId}}]`;
}

function withTemp(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cb-owner-'));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function writeSharedLog(root, lines) {
  const directory = path.join(root, '.codebuddy', 'logs', localDayKey());
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'proj__hash.log'), lines.join('\n') + '\n');
}

function writerOptions(root, resolveLogOwner) {
  return {
    fs,
    path,
    hostHomeDir: root,
    aiHomeDir: '',
    store: {},
    resolveLogOwner,
    readJsonlFromOffset
  };
}

test('parseLogPidUser 只认同 pid 的 userId / x-user-id', () => {
  assert.deepEqual(
    parseLogPidUser(`${TS} [Info] [pid=28415] [CloudProductManager] {"userId":"u1"}`),
    { pid: '28415', userId: 'u1' }
  );
  assert.deepEqual(
    parseLogPidUser(`${TS} [Info] [pid=28416] [X] {"x-user-id":"u2"}`),
    { pid: '28416', userId: 'u2' }
  );
  assert.equal(parseLogPidUser('[no pid] {"userId":"u3"}'), null);
});

test('共享日志：单进程会话可按 pid → userId 归属', () => withTemp((root) => {
  writeSharedLog(root, [
    userLine(111, 'u1'),
    writeLine(111, 'session-a', 'message-a')
  ]);
  const writer = createNativeMessageOwnership(writerOptions(root, ({ userId }) => (
    userId === 'u1' ? { provider: 'codebuddycn', accountRef: 'acct_a' } : null
  )));
  const file = { provider: 'codebuddy', sessionId: 'session-a', filePath: path.join(root, 'x') };

  assert.deepEqual(writer.sessionOwner(file), { provider: 'codebuddycn', accountRef: 'acct_a' });
  assert.deepEqual(writer.resolve(file, 'message-a', TS_MS), { provider: 'codebuddycn', accountRef: 'acct_a' });
}));

test('共享日志：同一会话多账号写入时保持空归属', () => withTemp((root) => {
  writeSharedLog(root, [
    userLine(111, 'u1'),
    writeLine(111, 'session-b', 'message-b1'),
    userLine(222, 'u2'),
    writeLine(222, 'session-b', 'message-b2')
  ]);
  const owners = { u1: { provider: 'codebuddycn', accountRef: 'acct_a' },
    u2: { provider: 'codebuddy', accountRef: 'acct_b' } };
  const writer = createNativeMessageOwnership(writerOptions(root, ({ userId }) => owners[userId] || null));
  const file = { provider: 'codebuddy', sessionId: 'session-b', filePath: path.join(root, 'x') };

  assert.equal(writer.sessionOwner(file), null);
  assert.deepEqual(writer.resolve(file, 'message-b1', TS_MS), { provider: 'codebuddycn', accountRef: 'acct_a' });
  assert.deepEqual(writer.resolve(file, 'message-b2', TS_MS), { provider: 'codebuddy', accountRef: 'acct_b' });
}));

test('共享日志：没有 userId 证据时不猜账号', () => withTemp((root) => {
  writeSharedLog(root, [writeLine(333, 'session-c', 'message-c')]);
  const writer = createNativeMessageOwnership(writerOptions(root, () => (
    { provider: 'codebuddy', accountRef: 'acct_guess' }
  )));
  const file = { provider: 'codebuddy', sessionId: 'session-c', filePath: path.join(root, 'x') };

  assert.equal(writer.sessionOwner(file), null);
  assert.equal(writer.resolve(file, 'message-c', TS_MS), null);
}));

test('持久会话注册表：nativeSessionId 只对应一个账号时可直接归属', () => withTemp((root) => {
  const aiHome = path.join(root, 'ai-home');
  const accountRef = 'acct_00000000000000000001';
  writeEntry(aiHome, {
    provider: 'codebuddycn', accountRef, runtimeScope: accountRef,
    socket: `aih-codebuddycn-${accountRef}`, session: 'p-test-1',
    nativeSessionId: 'session-e'
  }, { fs });

  const owners = readRegistrySessionOwners(aiHome, fs);
  assert.deepEqual([...owners.get('session-e')], [`codebuddycn:${accountRef}`]);
}));

test('持久会话注册表：同一会话被两个账号续写时不归属', () => withTemp((root) => {
  const aiHome = path.join(root, 'ai-home');
  const first = 'acct_00000000000000000001';
  const second = 'acct_00000000000000000002';
  writeEntry(aiHome, {
    provider: 'codebuddycn', accountRef: first, runtimeScope: first,
    socket: `aih-codebuddycn-${first}`, session: 'p-test-1',
    nativeSessionId: 'session-f'
  }, { fs });
  writeEntry(aiHome, {
    provider: 'codebuddycn', accountRef: second, runtimeScope: second,
    socket: `aih-codebuddycn-${second}`, session: 'p-test-2',
    nativeSessionId: 'session-f'
  }, { fs });

  const owners = readRegistrySessionOwners(aiHome, fs);
  assert.equal(owners.get('session-f').size, 2);
}));

test('账号投影里的私有日志仍按目录归属（兼容旧会话）', () => withTemp((root) => {
  const aiHome = path.join(root, 'ai-home');
  const accountRef = 'acct_00000000000000000001';
  const directory = path.join(aiHome, 'run', 'auth-projections', 'codebuddycn', accountRef, '.codebuddy-cn', 'logs', localDayKey());
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'private.log'), [
    writeLine(444, 'session-d', 'message-d')
  ].join('\n') + '\n');

  const writer = createNativeMessageOwnership({
    fs,
    path,
    aiHomeDir: aiHome,
    hostHomeDir: path.join(root, 'host-home'),
    accounts: new Map([[accountRef, 'codebuddycn']]),
    store: {},
    readJsonlFromOffset
  });
  const file = { provider: 'codebuddycn', sessionId: 'session-d', filePath: path.join(root, 'x') };

  assert.deepEqual(writer.sessionOwner(file), { provider: 'codebuddycn', accountRef });
}));
