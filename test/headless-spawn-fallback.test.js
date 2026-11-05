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
  // 未捕获异常的压缩 bundle 源码墙（几百 KB）——换路场景必须被扣下，不泼给用户。
  native.child.stderr.emit('data', '    deps: ${_}}`,"params")};let i={keyword:"dependencies"...splitDependencies...};\n');
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
  // 一行简明原因（含首行与 traceId）替代源码墙。
  const notice = chunks.find(([stream, text]) => stream === 'err' && text.includes('自动改走'));
  assert.ok(notice, '应有换路提示行');
  assert.ok(notice[1].includes('Select a model'), '提示行带 native 失败原因');
  assert.ok(notice[1].startsWith('[aih]'), '提示行是 aih 所有行');
  assert.ok(!chunks.some(([stream, text]) => stream === 'err' && text.includes('splitDependencies')), '压缩源码墙不外泼');
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

test('未命中签名（普通失败）不换路：扣住的 stderr 在退出前原样回放', async () => {
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
  native.child.stderr.emit('data', 'detail line 2\n');
  native.child.emit('close', 3);
  const { chunks, exit } = await done;
  assert.equal(spawns.length, 1, '签名未命中不换路');
  assert.equal(exit.exitCode, 3);
  // 不换路 = 行为不变：扣住的 stderr 在退出前按序回放。
  const stderrText = chunks.filter(([stream]) => stream === 'err').map(([, text]) => text).join('');
  assert.ok(stderrText.includes('Error: something else went wrong'), stderrText);
  assert.ok(stderrText.includes('detail line 2'), stderrText);
});

test('headlessRunner=native 时不换路，stderr 照常直通', async () => {
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
  const { chunks, exit } = await done;
  assert.equal(spawns.length, 1, 'native 逃生门关闭换路');
  assert.equal(exit.exitCode, 1);
  assert.ok(chunks.some(([stream, text]) => stream === 'err' && text.includes('Select a model')), 'native 模式 stderr 直通');
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
