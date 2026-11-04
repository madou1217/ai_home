'use strict';

// 回归守卫（2026-11-04 账号 1 真机）：`shouldFallbackFromNative` 在 runner 契约里
// 声明了却没有运行时消费方 —— auto 模式下 native `-p` 失败（"Select a model…" 等
// 签名）原样透出给用户，app-server 换路永远不会发生。守住：auto 模式下 native
// 输出命中签名 → 用 runner 垫片进程重跑一次（stdout/stderr/exitCode 语义不变）；
// 非 auto（native/强制 runner）与未命中签名时零行为差异。

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createHeadlessSpawn } = require('../lib/cli/services/pty/headless-spawn');

const LAUNCH = { command: '/bin/echo', args: ['native-cli'] };

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = null;
  child.kill = () => {};
  return child;
}

// headless-spawn 需要 detectHeadlessInvocation 认定这是 zcode 的 headless 调用。
const ZCODE_ARGS = ['-p', '你好'];

function createHarness(runner) {
  const spawns = [];
  const spawn = (command, args, spawnOptions) => {
    const child = makeFakeChild();
    spawns.push({ command, args, spawnOptions, child });
    return child;
  };
  const processObj = { platform: 'darwin', cwd: () => '/tmp', env: {}, stdin: null };
  const headlessSpawn = createHeadlessSpawn({ spawn, processObj, resolveHeadlessRunner: () => runner });
  return { headlessSpawn, spawns };
}

async function collect(handle) {
  const chunks = [];
  let exit = null;
  await new Promise((resolve) => {
    handle.onData((text) => chunks.push(['out', text]));
    handle.onErrorData((text) => chunks.push(['err', text]));
    handle.onExit((event) => { exit = event; resolve(); });
  });
  return { chunks, exit };
}

test('native 输出命中签名时自动换路到 runner，退出码取 runner', async () => {
  const runner = {
    id: 'fake',
    shouldPrefer: () => false,
    shouldFallbackFromNative: (text) => text.includes('Select a model before sending a message'),
    run: () => ({ exitCode: 0 })
  };
  const { headlessSpawn, spawns } = createHarness(runner);
  const handle = headlessSpawn.spawnHeadlessDirect(LAUNCH, { provider: 'zcode', env: {}, args: ZCODE_ARGS });
  const done = collect(handle);
  // native 子进程：stderr 打签名后退出 1（官方 standalone 对凭据不齐账号的失败形态）。
  // 换路在 close 事件里同步发生，随后回放 runner 垫片进程的答案与退出码。
  const native = spawns[0];
  assert.equal(native.command, LAUNCH.command, '首跑必须是 native 命令');
  native.child.stderr.emit('data', 'Error: Select a model before sending a message (traceId: x)\n');
  native.child.emit('close', 1);
  assert.equal(spawns.length, 2, '签名命中后应换路重跑一次');
  const fallback = spawns[1];
  assert.equal(fallback.command, process.execPath, '换路走 runner 垫片进程（node + trampoline）');
  assert.ok(fallback.args[0].includes('headless-runner-trampoline'), fallback.args[0]);
  fallback.child.stdout.emit('data', '答案正文\n');
  fallback.child.emit('close', 0);
  const { chunks, exit } = await done;

  assert.equal(exit.exitCode, 0);
  assert.ok(chunks.some(([stream, text]) => stream === 'out' && text === '答案正文\n'));
  // native 的 stderr 已流出（诚实透出失败），stdout 保持干净由 runner 填答案。
  assert.ok(chunks.some(([stream, text]) => stream === 'err' && text.includes('Select a model')));
});

test('换路子进程的 stdout 流给同一 onData，失败不再二次换路', async () => {
  const runner = {
    id: 'fake',
    shouldPrefer: () => false,
    shouldFallbackFromNative: (text) => text.includes('Select a model'),
    run: () => ({ exitCode: 0 })
  };
  const { headlessSpawn, spawns } = createHarness(runner);
  const handle = headlessSpawn.spawnHeadlessDirect(LAUNCH, { provider: 'zcode', env: {}, args: ZCODE_ARGS });
  const done = collect(handle);
  const native = spawns[0];
  native.child.stderr.emit('data', 'Select a model before sending a message\n');
  native.child.emit('close', 1);
  // 等 trampoline 进程被 spawn 出来再回放答案。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawns.length, 2);
  spawns[1].child.stdout.emit('data', '答案正文\n');
  spawns[1].child.emit('close', 0);
  const { chunks, exit } = await done;
  assert.equal(exit.exitCode, 0);
  assert.ok(chunks.some(([stream, text]) => stream === 'out' && text === '答案正文\n'));
});

test('未命中签名（普通失败）不换路，退出码原样透出', async () => {
  const runner = {
    id: 'fake',
    shouldPrefer: () => false,
    shouldFallbackFromNative: (text) => text.includes('Select a model'),
    run: () => ({ exitCode: 0 })
  };
  const { headlessSpawn, spawns } = createHarness(runner);
  const handle = headlessSpawn.spawnHeadlessDirect(LAUNCH, { provider: 'zcode', env: {}, args: ZCODE_ARGS });
  const done = collect(handle);
  const native = spawns[0];
  native.child.stderr.emit('data', 'Error: something else went wrong\n');
  native.child.emit('close', 3);
  const { exit } = await done;
  assert.equal(spawns.length, 1, '签名未命中不换路');
  assert.equal(exit.exitCode, 3);
});

test('headlessRunner=native 时不换路', async () => {
  const runner = {
    id: 'fake',
    shouldPrefer: () => false,
    shouldFallbackFromNative: () => true,
    run: () => ({ exitCode: 0 })
  };
  const { headlessSpawn, spawns } = createHarness(runner);
  const handle = headlessSpawn.spawnHeadlessDirect(LAUNCH, {
    provider: 'zcode', env: {}, args: ZCODE_ARGS, headlessRunner: 'native'
  });
  const done = collect(handle);
  const native = spawns[0];
  native.child.stderr.emit('data', 'Select a model before sending a message\n');
  native.child.emit('close', 1);
  const { exit } = await done;
  assert.equal(spawns.length, 1, 'native 逃生门关闭换路');
  assert.equal(exit.exitCode, 1);
});

test('headlessRunner=app-server 强制模式首跑就是 runner 垫片，失败不二次换路', async () => {
  const runner = {
    id: 'fake',
    shouldPrefer: () => false,
    shouldFallbackFromNative: () => true,
    run: () => ({ exitCode: 0 })
  };
  const { headlessSpawn, spawns } = createHarness(runner);
  const handle = headlessSpawn.spawnHeadlessDirect(LAUNCH, {
    provider: 'zcode', env: {}, args: ZCODE_ARGS, headlessRunner: 'app-server'
  });
  const done = collect(handle);
  assert.equal(spawns[0].command, process.execPath, '强制模式直接替换为垫片进程');
  spawns[0].child.stderr.emit('data', 'Select a model before sending a message\n');
  spawns[0].child.emit('close', 1);
  const { exit } = await done;
  assert.equal(spawns.length, 1, 'runner 自身失败不再换路');
  assert.equal(exit.exitCode, 1);
});
