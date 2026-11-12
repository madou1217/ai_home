'use strict';

// 换号退休旧持久会话：判定（谁的会话、有没有别人在看）+ 执行（kill-session）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  capturePersistentSessionRetire,
  planPersistentSessionRetire,
  readAttachedClientCount,
  retirePersistentSession
} = require('../lib/cli/services/pty/persistent-session-retire');

function fakeProc(info) {
  return { aihPersistentSessionInfo: info };
}

function ownedInfo(overrides = {}) {
  return {
    command: 'tmux',
    socket: 'aih-codebuddy-acct_aaa',
    session: 'p-ai_home-1',
    owned: true,
    ...overrides
  };
}

function recorder(result = { status: 0, stdout: '1\n' }) {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    return result;
  };
  return { calls, spawnSync };
}

test('plan：本次新建的持久会话才可退休', () => {
  assert.deepEqual(
    planPersistentSessionRetire(fakeProc(ownedInfo())),
    { command: 'tmux', socket: 'aih-codebuddy-acct_aaa', session: 'p-ai_home-1' }
  );
  // 用户已有的会话（reattach / takeover / mirror）：换号不替用户关。
  assert.equal(planPersistentSessionRetire(fakeProc(ownedInfo({ owned: false }))), null);
  // 非持久会话（普通 PTY）：没有会话可退休。
  assert.equal(planPersistentSessionRetire({}), null);
  assert.equal(planPersistentSessionRetire(null), null);
  // 字段缺失不猜。
  assert.equal(planPersistentSessionRetire(fakeProc(ownedInfo({ session: '' }))), null);
  assert.equal(planPersistentSessionRetire(fakeProc(ownedInfo({ socket: '   ' }))), null);
});

test('attached：读 tmux 的 session_attached；读不到按「只有我们」处理', () => {
  const ok = recorder({ status: 0, stdout: '2\n' });
  assert.equal(readAttachedClientCount(planPersistentSessionRetire(fakeProc(ownedInfo())), ok), 2);
  assert.deepEqual(ok.calls[0].args.slice(0, 5), ['-L', 'aih-codebuddy-acct_aaa', 'display-message', '-p', '-t']);
  assert.equal(ok.calls[0].args[5], 'p-ai_home-1');
  assert.equal(ok.calls[0].args[6], '#{session_attached}');

  assert.equal(readAttachedClientCount(null, ok), null);
  const broken = recorder({ status: 1, stdout: '' });
  assert.equal(readAttachedClientCount(planPersistentSessionRetire(fakeProc(ownedInfo())), broken), null);
});

test('capture：有别的客户端附着时不退休（镜像 / 另一个终端）', () => {
  const mirror = recorder({ status: 0, stdout: '2\n' });
  assert.equal(
    capturePersistentSessionRetire(fakeProc(ownedInfo()), mirror),
    null
  );
  const sole = recorder({ status: 0, stdout: '1\n' });
  assert.deepEqual(
    capturePersistentSessionRetire(fakeProc(ownedInfo()), sole),
    { command: 'tmux', socket: 'aih-codebuddy-acct_aaa', session: 'p-ai_home-1' }
  );
  // 0 个客户端（客户端刚掉线）也可以退休。
  const detached = recorder({ status: 0, stdout: '0\n' });
  assert.ok(capturePersistentSessionRetire(fakeProc(ownedInfo()), detached));
});

test('retire：只杀这一个会话，失败不外抛', () => {
  const ok = recorder({ status: 0 });
  assert.deepEqual(retirePersistentSession(
    { command: 'tmux', socket: 'aih-codebuddy-acct_aaa', session: 'p-ai_home-1' },
    ok
  ), { ok: true });
  assert.deepEqual(ok.calls[0].args, ['-L', 'aih-codebuddy-acct_aaa', 'kill-session', '-t', 'p-ai_home-1']);

  const failed = recorder({ status: 1 });
  assert.equal(retirePersistentSession({ command: 'tmux', socket: 's', session: 'n' }, failed).ok, false);

  const throwing = { spawnSync: () => { throw new Error('tmux missing'); } };
  assert.deepEqual(
    retirePersistentSession({ command: 'tmux', socket: 's', session: 'n' }, throwing),
    { ok: false, reason: 'tmux missing' }
  );
  assert.equal(retirePersistentSession(null, ok).ok, false);
});
