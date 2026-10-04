'use strict';

// 插件架构 M0 的验收测试：合同不漂移、制品版本固定、分帧上限、静态依赖诊断，
// 以及真实 Plugin Host 子进程上的加载/卸载、取消、超时、版本不兼容、有界大 payload、崩溃诊断。
// 外部插件放在仓库外的临时目录，只依赖 SDK。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const contract = require('../lib/plugins/sdk/contract.generated.json');
const { run: runContractGenerator } = require('../scripts/generate-plugin-contract');
const { encodeFrame, FrameDecoder } = require('../lib/plugins/transport/frame');
const { createRpcClient } = require('../lib/plugins/transport/rpc-client');
const { planGeneration } = require('../lib/plugins/host/dependency-graph');
const { createPluginHostSupervisor, buildHostEnvironment } = require('../lib/plugins/host/supervisor');

const ROOT = path.resolve(__dirname, '..');
const SAMPLE_DIR = path.join(ROOT, 'examples', 'plugins', 'echo');

// macOS 的 os.tmpdir() 很长，Unix socket 路径上限 104 字节；POSIX 上用 /tmp。
function shortTempDir(prefix) {
  const base = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  return fs.mkdtempSync(path.join(base, prefix));
}

function socketFor(dir) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\aih-plugin-test-${path.basename(dir)}`
    : path.join(dir, 'h.sock');
}

function manifest(pluginId, extra = {}) {
  return {
    manifestVersion: 1,
    protocolVersion: 1,
    pluginId,
    version: '0.1.0',
    engines: { aih: '>=1.0.0' },
    runtime: 'node',
    entry: 'index.mjs',
    contributes: [],
    ...extra
  };
}

function writePlugin(dir, name, pluginManifest, source) {
  const pluginDir = path.join(dir, name);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(pluginManifest));
  fs.writeFileSync(path.join(pluginDir, 'index.mjs'), source);
  return { instanceId: name, manifest: pluginManifest, entryPath: path.join(pluginDir, 'index.mjs') };
}

function copySample(dir) {
  const target = path.join(dir, 'echo');
  fs.cpSync(SAMPLE_DIR, target, { recursive: true });
  return {
    instanceId: 'echo',
    manifest: JSON.parse(fs.readFileSync(path.join(target, 'plugin.json'), 'utf8')),
    entryPath: path.join(target, 'index.mjs')
  };
}

async function withHost(fn, options = {}) {
  const dir = shortTempDir('aihp-');
  const supervisor = createPluginHostSupervisor({ aiHomeDir: dir, socketPath: socketFor(dir), ...options });
  try {
    await supervisor.start();
    await fn({ dir, supervisor });
  } finally {
    await supervisor.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const call = async (supervisor, method, value, options) => (await supervisor.call(method, value, options)).value;

// ---- 合同与制品 ----

test('plugin contract generated artifacts are current', () => {
  assert.deepEqual(runContractGenerator({ check: true }), []);
});

test('pinned plugin runtime dependencies match what is installed', () => {
  for (const dependency of contract.runtimeDependencies) {
    const installed = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', dependency.name, 'package.json'), 'utf8'));
    assert.equal(installed.version, dependency.version, dependency.name);
  }
  // npm 安装时校验过 tarball 并把 integrity 记在 node_modules/.package-lock.json：与合同记录逐一比对。
  const installedLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '.package-lock.json'), 'utf8'));
  for (const dependency of contract.runtimeDependencies) {
    assert.equal(installedLock.packages[`node_modules/${dependency.name}`]?.integrity, dependency.integrity, `${dependency.name} integrity`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['@deepseek-ai/cordis'], '4.0.4');
  assert.equal(pkg.overrides['@deepseek-ai/cosmokit'], '1.8.5');
});

// ---- 分帧 ----

test('frames round-trip JSON metadata and binary payload; the payload limit is exact', () => {
  const frames = [];
  const decoder = new FrameDecoder((frame) => frames.push(frame));
  const atLimit = Buffer.alloc(contract.limits.payloadBytes, 1);
  decoder.push(encodeFrame({ kind: 'call', protocolVersion: 1, id: 'a', method: 'm', value: { x: 1 } }, atLimit));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].message.value, { x: 1 });
  assert.equal(frames[0].payload.length, contract.limits.payloadBytes);
  assert.throws(() => encodeFrame({ kind: 'call', protocolVersion: 1, id: 'b' }, Buffer.alloc(contract.limits.payloadBytes + 1)),
    { code: 'plugin_rpc_payload_limit' });
});

test('decoder rejects oversized headers before buffering their bodies', () => {
  const decoder = new FrameDecoder(() => {});
  const header = Buffer.alloc(12);
  header.writeUInt32BE(16);
  header.writeBigUInt64BE(BigInt(contract.limits.payloadBytes + 1), 4);
  assert.throws(() => decoder.push(header), { code: 'plugin_rpc_payload_limit' });
  const metadataHeader = Buffer.alloc(12);
  metadataHeader.writeUInt32BE(contract.limits.metadataBytes + 1);
  assert.throws(() => new FrameDecoder(() => {}).push(metadataHeader), { code: 'plugin_rpc_metadata_limit' });
});

// ---- 静态依赖诊断 ----

test('dependency plan orders providers first and diagnoses missing, mismatched and cyclic services', () => {
  const ok = planGeneration([
    { instanceId: 'consumer', manifest: manifest('c', { requires: [{ name: 'svc.a', versionRange: '^1.0.0' }] }) },
    { instanceId: 'provider', manifest: manifest('p', { provides: [{ name: 'svc.a', version: '1.2.0' }] }) }
  ]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.order, ['provider', 'consumer']);

  const missing = planGeneration([{ instanceId: 'consumer', manifest: manifest('c', { requires: [{ name: 'svc.a', versionRange: '^1.0.0' }] }) }]);
  assert.equal(missing.diagnostics[0].code, 'plugin_service_missing');

  const mismatch = planGeneration([
    { instanceId: 'consumer', manifest: manifest('c', { requires: [{ name: 'svc.a', versionRange: '^2.0.0' }] }) },
    { instanceId: 'provider', manifest: manifest('p', { provides: [{ name: 'svc.a', version: '1.2.0' }] }) }
  ]);
  assert.equal(mismatch.diagnostics[0].code, 'plugin_service_version_mismatch');

  const cycle = planGeneration([
    { instanceId: 'a', manifest: manifest('a', { provides: [{ name: 'svc.x', version: '1.0.0' }], requires: [{ name: 'svc.y', versionRange: '*' }] }) },
    { instanceId: 'b', manifest: manifest('b', { provides: [{ name: 'svc.y', version: '1.0.0' }], requires: [{ name: 'svc.x', versionRange: '*' }] }) }
  ]);
  assert.equal(cycle.diagnostics[0].code, 'plugin_dependency_cycle');
  assert.deepEqual(cycle.diagnostics[0].cycle, ['a', 'b', 'a']);

  const hostOk = planGeneration([{ instanceId: 'h', manifest: manifest('h', { requires: [{ name: 'aih', versionRange: '^1.0.0' }] }) }]);
  assert.equal(hostOk.ok, true);
  const hostTooNew = planGeneration([{ instanceId: 'h', manifest: manifest('h', { requires: [{ name: 'aih', versionRange: '^2.0.0' }] }) }]);
  assert.equal(hostTooNew.diagnostics[0].code, 'plugin_service_version_mismatch');
  assert.match(hostTooNew.diagnostics[0].detail, /aih@\^2\.0\.0/);

  const duplicate = planGeneration([
    { instanceId: 'one', manifest: manifest('same') },
    { instanceId: 'two', manifest: manifest('same') }
  ]);
  assert.equal(duplicate.diagnostics[0].code, 'plugin_id_duplicate');
});

// ---- 宿主进程 ----

test('plugin host environment is built from an allowlist without gateway secrets', () => {
  const env = buildHostEnvironment({ PATH: '/bin', AIH_SERVER_MANAGEMENT_KEY: 'secret', OPENAI_API_KEY: 'k' }, { AIH_PLUGIN_SOCKET: 's' });
  assert.deepEqual(env, { PATH: '/bin', AIH_PLUGIN_SOCKET: 's' });
});

test('external sample loads, round-trips a bounded large payload, and unloads after its async disposer', async () => {
  await withHost(async ({ dir, supervisor }) => {
    const sample = copySample(dir);
    const prepared = await call(supervisor, 'prepare', { generation: 1, plugins: [sample] });
    assert.equal(prepared.state, 'prepared', JSON.stringify(prepared));
    assert.deepEqual(prepared.contributions, ['sample.echo.call', 'sample.echo.stats', 'sample.echo.wait']);
    await call(supervisor, 'activate', { generation: 1 });

    const big = Buffer.alloc(contract.limits.payloadBytes, 0xab);
    const echoed = await supervisor.call('invoke', { contributionId: 'sample.echo.call', value: { n: 1 } }, { payload: big });
    assert.equal(echoed.value.bytes, big.length);
    assert.equal(echoed.payload.equals(big), true);
    await assert.rejects(supervisor.call('invoke', { contributionId: 'sample.echo.call' }, { payload: Buffer.alloc(big.length + 1) }),
      { code: 'plugin_rpc_payload_limit' });

    const started = Date.now();
    const disposed = await call(supervisor, 'dispose', { generation: 1 });
    assert.equal(disposed.state, 'disposed');
    assert.ok(Date.now() - started >= 20, '卸载应等待样例 20ms 的异步 disposer');
    await assert.rejects(supervisor.call('invoke', { contributionId: 'sample.echo.call' }), { code: 'plugin_generation_unknown' });
  });
});

test('cancellation and deadlines reach the plugin handler', async () => {
  await withHost(async ({ dir, supervisor }) => {
    await call(supervisor, 'prepare', { generation: 1, plugins: [copySample(dir)] });
    await call(supervisor, 'activate', { generation: 1 });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(supervisor.call('invoke', { contributionId: 'sample.echo.wait' }, { signal: controller.signal }),
      { code: 'plugin_rpc_cancelled' });
    await assert.rejects(supervisor.call('invoke', { contributionId: 'sample.echo.wait' }, { timeoutMs: 60 }),
      { code: 'plugin_rpc_timeout' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stats = await call(supervisor, 'invoke', { contributionId: 'sample.echo.stats' });
    assert.equal(stats.aborts, 2);
  });
});

test('incompatible protocol versions get an explicit error with the supported range; a bad token gets nothing', async () => {
  const token = 'f'.repeat(64);
  await withHost(async ({ supervisor }) => {
    const { socketPath } = supervisor.status();
    const future = createRpcClient({ socketPath, token, protocolVersion: contract.supportedProtocolVersions.max + 1 });
    await assert.rejects(future.connect(), (error) => {
      assert.equal(error.code, 'plugin_rpc_incompatible');
      assert.deepEqual(error.supported, contract.supportedProtocolVersions);
      return true;
    });
    future.close();
    const intruder = createRpcClient({ socketPath, token: 'e'.repeat(64) });
    await assert.rejects(intruder.connect(), { code: 'plugin_rpc_closed' });
    intruder.close();
  }, { token });
});

test('missing services are diagnosed before load and recover once a provider is enabled', async () => {
  await withHost(async ({ dir, supervisor }) => {
    const consumer = writePlugin(dir, 'consumer', manifest('aih.test.consumer', {
      requires: [{ name: 'svc.greeting', versionRange: '^1.0.0' }],
      contributes: [{ id: 'consumer.greet', capability: 'command', version: 1 }]
    }), `export default { apply(ctx) {
      ctx.aih.register('consumer.greet', () => ctx.get('svc.greeting').greet());
    } };`);
    const provider = writePlugin(dir, 'provider', manifest('aih.test.provider', {
      provides: [{ name: 'svc.greeting', version: '1.1.0' }]
    }), `export default { apply(ctx) { ctx.aih.provide('svc.greeting', { greet: () => 'hello' }); } };`);

    const rejected = await call(supervisor, 'prepare', { generation: 1, plugins: [consumer] });
    assert.equal(rejected.state, 'rejected');
    assert.equal(rejected.diagnostics[0].code, 'plugin_service_missing');

    const recovered = await call(supervisor, 'prepare', { generation: 2, plugins: [consumer, provider] });
    assert.equal(recovered.state, 'prepared', JSON.stringify(recovered));
    assert.deepEqual(recovered.order, ['provider', 'consumer']);
    await call(supervisor, 'activate', { generation: 2 });
    assert.equal(await call(supervisor, 'invoke', { contributionId: 'consumer.greet' }), 'hello');
  });
});

test('dependency cycles, failing plugins and undeclared contributions are rejected with diagnostics', async () => {
  await withHost(async ({ dir, supervisor }) => {
    const a = writePlugin(dir, 'a', manifest('aih.test.a', {
      provides: [{ name: 'svc.x', version: '1.0.0' }], requires: [{ name: 'svc.y', versionRange: '*' }]
    }), 'export default { apply() {} };');
    const b = writePlugin(dir, 'b', manifest('aih.test.b', {
      provides: [{ name: 'svc.y', version: '1.0.0' }], requires: [{ name: 'svc.x', versionRange: '*' }]
    }), 'export default { apply() {} };');
    const cycle = await call(supervisor, 'prepare', { generation: 1, plugins: [a, b] });
    assert.equal(cycle.diagnostics[0].code, 'plugin_dependency_cycle');

    const broken = writePlugin(dir, 'broken', manifest('aih.test.broken'), `export default { apply() { throw new Error('boom at apply'); } };`);
    const failed = await call(supervisor, 'prepare', { generation: 2, plugins: [broken] });
    assert.equal(failed.diagnostics[0].code, 'plugin_apply_failed');
    assert.match(failed.diagnostics[0].detail, /boom at apply/);

    const sneaky = writePlugin(dir, 'sneaky', manifest('aih.test.sneaky'),
      `export default { apply(ctx) { ctx.aih.register('not.declared', () => 1); } };`);
    const undeclared = await call(supervisor, 'prepare', { generation: 3, plugins: [sneaky] });
    assert.equal(undeclared.diagnostics[0].code, 'plugin_apply_failed');
    assert.match(undeclared.diagnostics[0].detail, /not\.declared/);
    assert.deepEqual((await call(supervisor, 'status')).generations, []);
  });
});

test('unsupported capability versions and incompatible hosts are rejected before any code loads', async () => {
  await withHost(async ({ dir, supervisor }) => {
    const future = writePlugin(dir, 'future', manifest('aih.test.future', {
      contributes: [{ id: 'future.cmd', capability: 'command', version: 2 }]
    }), 'throw new Error("must not be imported");');
    const rejected = await call(supervisor, 'prepare', { generation: 1, plugins: [future] });
    assert.equal(rejected.state, 'rejected');
    assert.equal(rejected.diagnostics[0].code, 'plugin_capability_incompatible');

    const tooNew = writePlugin(dir, 'too-new', manifest('aih.test.too-new', { engines: { aih: '>=99.0.0' } }),
      'throw new Error("must not be imported");');
    const host = await call(supervisor, 'prepare', { generation: 2, plugins: [tooNew] });
    assert.equal(host.diagnostics[0].code, 'plugin_host_incompatible');
  });
});

// 返回值不靠猜：带 value 字段的普通对象原样透传，只有 withPayload 才附带二进制。
test('handler results are passed through verbatim unless wrapped with withPayload', async () => {
  await withHost(async ({ dir, supervisor }) => {
    const plugin = writePlugin(dir, 'shape', manifest('aih.test.shape', {
      contributes: [
        { id: 'shape.plain', capability: 'command', version: 1 },
        { id: 'shape.bytes', capability: 'command', version: 1 }
      ]
    }), `import { withPayload } from '@ai-home/plugin-sdk';
      export default { apply(ctx) {
        ctx.aih.register('shape.plain', () => ({ value: 1, extra: 2 }));
        ctx.aih.register('shape.bytes', () => withPayload({ ok: true }, new Uint8Array([1, 2, 3])));
      } };`);
    await call(supervisor, 'prepare', { generation: 1, plugins: [plugin] });
    await call(supervisor, 'activate', { generation: 1 });
    assert.deepEqual(await call(supervisor, 'invoke', { contributionId: 'shape.plain' }), { value: 1, extra: 2 });
    const bytes = await supervisor.call('invoke', { contributionId: 'shape.bytes' });
    assert.deepEqual(bytes.value, { ok: true });
    assert.deepEqual([...bytes.payload], [1, 2, 3]);
  });
});

// 入口里的相对 import 不带代次参数时，helper 的模块级状态会被新旧代次共享。
test('module state in helper files is isolated per generation', async () => {
  await withHost(async ({ dir, supervisor }) => {
    const plugin = writePlugin(dir, 'counter', manifest('aih.test.counter', {
      contributes: [{ id: 'counter.next', capability: 'command', version: 1 }]
    }), `import { next } from './counter.mjs';
      export default { apply(ctx) { ctx.aih.register('counter.next', () => next()); } };`);
    fs.writeFileSync(path.join(dir, 'counter', 'counter.mjs'), 'let count = 0; export function next() { count += 1; return count; }');
    await call(supervisor, 'prepare', { generation: 1, plugins: [plugin] });
    await call(supervisor, 'activate', { generation: 1 });
    assert.equal(await call(supervisor, 'invoke', { contributionId: 'counter.next' }), 1);
    assert.equal(await call(supervisor, 'invoke', { contributionId: 'counter.next' }), 2);
    await call(supervisor, 'prepare', { generation: 2, plugins: [plugin] });
    await call(supervisor, 'activate', { generation: 2 });
    assert.equal(await call(supervisor, 'invoke', { contributionId: 'counter.next' }), 1);
  });
});

test('a throwing disposer does not block unload and is attributed to its instance', async () => {
  await withHost(async ({ dir, supervisor }) => {
    const plugin = writePlugin(dir, 'leaky', manifest('aih.test.leaky'),
      `export default { apply(ctx) { ctx.effect(() => () => { throw new Error('disposer exploded'); }, 'bad'); } };`);
    await call(supervisor, 'prepare', { generation: 1, plugins: [plugin] });
    const disposed = await call(supervisor, 'dispose', { generation: 1 });
    assert.equal(disposed.state, 'disposed');
    assert.ok(disposed.errors.some((item) => item.instanceId === 'leaky' && /disposer exploded/.test(item.message)), JSON.stringify(disposed.errors));
  });
});

test('plugins cannot read gateway secrets or the host RPC token from the environment', async () => {
  await withHost(async ({ dir, supervisor }) => {
    const plugin = writePlugin(dir, 'snoop', manifest('aih.test.snoop', {
      contributes: [{ id: 'snoop.env', capability: 'command', version: 1 }]
    }), `export default { apply(ctx) { ctx.aih.register('snoop.env', () => ({
      key: process.env.AIH_TEST_GATEWAY_SECRET || null,
      hostToken: process.env.AIH_PLUGIN_TOKEN || null
    })); } };`);
    await call(supervisor, 'prepare', { generation: 1, plugins: [plugin] });
    await call(supervisor, 'activate', { generation: 1 });
    assert.deepEqual(await call(supervisor, 'invoke', { contributionId: 'snoop.env' }), { key: null, hostToken: null });
  }, { env: { ...process.env, AIH_TEST_GATEWAY_SECRET: 'must-not-leak' } });
});

test('the plugin host exits when its parent goes away instead of lingering as an orphan', async () => {
  const { spawn } = require('node:child_process');
  const dir = shortTempDir('aihp-');
  const socketPath = socketFor(dir);
  const script = `
    const { createPluginHostSupervisor } = require(${JSON.stringify(path.join(ROOT, 'lib/plugins/host/supervisor'))});
    const supervisor = createPluginHostSupervisor({ aiHomeDir: ${JSON.stringify(dir)}, socketPath: ${JSON.stringify(socketPath)} });
    supervisor.start().then(() => { process.stdout.write(String(supervisor.status().pid) + '\\n'); });
    setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const hostPid = await new Promise((resolve, reject) => {
      parent.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
      parent.once('exit', () => reject(new Error('parent exited early')));
    });
    assert.ok(hostPid > 0);
    parent.kill('SIGKILL');
    const deadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try { process.kill(hostPid, 0); } catch (_error) { alive = false; }
    }
    assert.equal(alive, false, '父进程被杀后插件宿主应在几秒内退出');
  } finally {
    try { parent.kill('SIGKILL'); } catch (_error) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a crashed host fails in-flight calls with plugin_rpc_closed and records the exit', async () => {
  await withHost(async ({ dir, supervisor }) => {
    const plugin = writePlugin(dir, 'crasher', manifest('aih.test.crasher', {
      contributes: [{ id: 'crash.now', capability: 'command', version: 1 }]
    }), `export default { apply(ctx) { ctx.aih.register('crash.now', () => { setTimeout(() => process.exit(7), 10); return new Promise(() => {}); }); } };`);
    await call(supervisor, 'prepare', { generation: 1, plugins: [plugin] });
    await call(supervisor, 'activate', { generation: 1 });
    await assert.rejects(supervisor.call('invoke', { contributionId: 'crash.now' }, { timeoutMs: 5000 }), { code: 'plugin_rpc_closed' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(supervisor.status().lastExit.code, 7);
  });
});

// ---- 空链快路径 ----

test('an empty chain returns immediately without starting the plugin host', async () => {
  const { createPluginDispatcher } = require('../lib/plugins/host/dispatcher');
  let calls = 0;
  const dispatcher = createPluginDispatcher({ supervisor: { call: async () => { calls += 1; return { value: null }; } } });
  const input = { model: 'gpt-x' };
  assert.deepEqual(await dispatcher.dispatch('gateway.request', input), { value: input, invoked: 0 });
  dispatcher.publish(1, [{ id: 'only.observe', capability: 'observe', instanceId: 'a' }]);
  assert.deepEqual(await dispatcher.dispatch('gateway.request', input), { value: input, invoked: 0 });
  assert.equal(calls, 0);
  await dispatcher.dispatch('observe', input);
  assert.equal(calls, 1);
});
