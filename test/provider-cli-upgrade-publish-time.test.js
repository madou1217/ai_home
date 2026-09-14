'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { fetchNpmPublishTime } = require('../lib/server/provider-cli-upgrade/upgrade-publish-time');

// 假 npm：脚本化 stdout/stderr/退出码，全程不联网、不起真进程。
function fakeNpm(script) {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    setImmediate(() => script(child));
    return child;
  };
  return { spawn, calls };
}

const TIME_TABLE = JSON.stringify({
  created: '2025-04-01T00:00:00.000Z',
  modified: '2026-09-13T10:00:00.000Z',
  '0.153.4': '2026-09-01T08:30:00.000Z',
  '0.154.0': '2026-09-13T09:15:00.000Z'
});

test('从整张 time 表里取出指定版本的发布时间', async () => {
  const npm = fakeNpm((child) => {
    child.stdout.emit('data', TIME_TABLE);
    child.emit('close', 0);
  });

  const result = await fetchNpmPublishTime('@openai/codex', '0.154.0', { spawn: npm.spawn });
  assert.deepEqual(result, { ok: true, publishedAt: Date.parse('2026-09-13T09:15:00.000Z'), error: '' });

  // 必须绕开用户 .npmrc 并钉死官方 registry，否则私服会给出不相干的时间。
  const args = npm.calls[0].args;
  assert.deepEqual(args.slice(0, 4), ['view', '@openai/codex', 'time', '--json']);
  assert.ok(args.some((arg) => arg.startsWith('--userconfig=')));
  assert.ok(args.includes('--registry=https://registry.npmjs.org'));
});

// 这条是整个 soak 闸门的命脉：拿不到 publishedAt，policy 的两个分支都是 SKIP，
// 自动升级会变成一块永远绿着、却从不升级任何东西的仪表盘。所以失败必须显式可见。
test('registry 回来的表里没有这个版本 → 显式报 publish_time_missing', async () => {
  const npm = fakeNpm((child) => {
    child.stdout.emit('data', TIME_TABLE);
    child.emit('close', 0);
  });

  const result = await fetchNpmPublishTime('@openai/codex', '9.9.9', { spawn: npm.spawn });
  assert.deepEqual(result, { ok: false, publishedAt: 0, error: 'publish_time_missing' });
});

test('registry 压根没有 time 字段时同样显式失败', async () => {
  const npm = fakeNpm((child) => {
    child.stdout.emit('data', '{}');
    child.emit('close', 0);
  });

  const result = await fetchNpmPublishTime('@openai/codex', '0.154.0', { spawn: npm.spawn });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'publish_time_missing');
});

test('npm 退出码非 0 时带上 stderr', async () => {
  const npm = fakeNpm((child) => {
    child.stderr.emit('data', 'npm error code E404\n');
    child.emit('close', 1);
  });

  const result = await fetchNpmPublishTime('@openai/codex', '0.154.0', { spawn: npm.spawn });
  assert.equal(result.ok, false);
  assert.match(result.error, /E404/);
});

test('输出不是 JSON 时报 npm_view_unparsable', async () => {
  const npm = fakeNpm((child) => {
    child.stdout.emit('data', 'not json at all');
    child.emit('close', 0);
  });

  assert.equal((await fetchNpmPublishTime('@openai/codex', '0.154.0', { spawn: npm.spawn })).error, 'npm_view_unparsable');
});

test('时间戳解析不了时不静默当成 0', async () => {
  const npm = fakeNpm((child) => {
    child.stdout.emit('data', JSON.stringify({ '0.154.0': 'yesterday-ish' }));
    child.emit('close', 0);
  });

  const result = await fetchNpmPublishTime('@openai/codex', '0.154.0', { spawn: npm.spawn });
  assert.deepEqual(result, { ok: false, publishedAt: 0, error: 'publish_time_unparsable' });
});

test('卡住的 npm 会被超时掐掉', async () => {
  let killed = false;
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; };
    return child; // 永不 close
  };

  // 超时定时器是 unref 的（绝不让它把 server 拖着不退出），而假 spawn 不占任何 handle，
  // 所以测试里要自己按住事件循环，否则 node 会在定时器到点前就判定无事可做。
  const keepAlive = setTimeout(() => {}, 5000);
  const result = await fetchNpmPublishTime('@openai/codex', '0.154.0', { spawn, timeoutMs: 1000 });
  clearTimeout(keepAlive);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'npm_view_timeout');
  assert.equal(killed, true);
});

test('包名或版本号不合法时根本不起进程', async () => {
  let spawned = 0;
  const spawn = () => { spawned += 1; throw new Error('should not spawn'); };

  assert.equal((await fetchNpmPublishTime('', '1.0.0', { spawn })).error, 'unsupported_package');
  assert.equal((await fetchNpmPublishTime('pkg; rm -rf /', '1.0.0', { spawn })).error, 'unsupported_package');
  assert.equal((await fetchNpmPublishTime('@openai/codex', '', { spawn })).error, 'unsupported_version');
  assert.equal(spawned, 0);
});

test('spawn 直接抛错时如实报回,不抛给调用方', async () => {
  const result = await fetchNpmPublishTime('@openai/codex', '0.154.0', {
    spawn: () => { throw new Error('spawn ENOENT'); }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
});
