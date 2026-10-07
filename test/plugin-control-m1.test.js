'use strict';

// 插件架构 M1 验收：离线插件包与摘要校验、控制面状态（CAS）、发布协议（准备 → 提交 → 激活）、
// 宿主崩溃恢复与按代数回收、监听器/定时器清理、严格鉴权的管理路由，以及经真实 aih server 与 CLI 的
// 「打包 → 安装 → 配置启用 → 调用 → 停用 → 重启后恢复」闭环。
// 全部在 /tmp 下的临时 aiHomeDir 与随机端口上运行，不触碰用户的 ~/.ai_home 与 9527。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { MAGIC, acceptArtifact, buildArtifact } = require('../lib/plugins/control/artifact');
const { createPluginStateStore } = require('../lib/plugins/control/state-store');
const { createPluginSystem } = require('../lib/plugins/control/plugin-system');
const { runPluginCommand } = require('../lib/plugins/control/cli');

const ROOT = path.resolve(__dirname, '..');
const SAMPLE_DIR = path.join(ROOT, 'examples', 'plugins', 'echo');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', prefix));
}

function socketFor(dir) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\aih-plugin-m1-${path.basename(dir)}` : path.join(dir, 'h.sock');
}

function manifest(pluginId, extra = {}) {
  return {
    manifestVersion: 1, protocolVersion: 1, pluginId, version: '0.1.0',
    engines: { aih: '>=1.0.0' }, runtime: 'node', entry: 'index.mjs', contributes: [], ...extra
  };
}

function writePluginSource(dir, name, pluginManifest, source, extraFiles = {}) {
  const pluginDir = path.join(dir, 'src', name);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(pluginManifest));
  fs.writeFileSync(path.join(pluginDir, 'index.mjs'), source);
  for (const [file, content] of Object.entries(extraFiles)) fs.writeFileSync(path.join(pluginDir, file), content);
  return pluginDir;
}

function pack(dir, sourceDir, name) {
  return buildArtifact(sourceDir, path.join(dir, 'packages', `${name}.aih-plugin`)).file;
}

// 手工拼一个插件包（用来构造恶意/损坏的包）。
function rawPackage(file, pluginManifest, records) {
  const metadata = Buffer.from(JSON.stringify({
    formatVersion: 1, manifest: pluginManifest,
    files: records.map((record) => ({ path: record.path, size: record.data.length, sha256: record.sha256 || crypto.createHash('sha256').update(record.data).digest('hex') }))
  }));
  const header = Buffer.alloc(MAGIC.length + 4);
  MAGIC.copy(header, 0);
  header.writeUInt32BE(metadata.length, MAGIC.length);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, metadata, ...records.map((record) => record.data)]));
  return file;
}

function systemFor(dir, extra = {}) {
  const aiHomeDir = path.join(dir, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  return createPluginSystem({ aiHomeDir, socketPath: socketFor(dir), backoffMs: [50], ...extra });
}

async function withSystem(fn, extra = {}) {
  const dir = tempDir('aihm1-');
  const system = systemFor(dir, extra);
  try {
    await fn({ dir, ...system });
  } finally {
    await system.runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function emptyDir(dir) {
  return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

// ---- 插件包 ----

test('packing the external sample and accepting it verifies every file', () => {
  const dir = tempDir('aihm1-');
  try {
    const built = buildArtifact(SAMPLE_DIR, path.join(dir, 'echo.aih-plugin'));
    assert.equal(built.manifest.pluginId, 'aih.sample.echo');
    const accepted = acceptArtifact(built.file, { acceptedDir: path.join(dir, 'accepted'), extractedDir: path.join(dir, 'extracted') });
    assert.equal(accepted.digest, built.digest);
    assert.equal(fs.readFileSync(path.join(accepted.directory, 'index.mjs'), 'utf8'), fs.readFileSync(path.join(SAMPLE_DIR, 'index.mjs'), 'utf8'));
    // 同一个包再接受一次是幂等的。
    assert.equal(acceptArtifact(built.file, { acceptedDir: path.join(dir, 'accepted'), extractedDir: path.join(dir, 'extracted') }).digest, built.digest);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bad packages are rejected without leaving files or changing plugin state', async () => {
  await withSystem(async ({ dir, control }) => {
    const good = manifest('aih.test.bad');
    const entry = { path: 'index.mjs', data: Buffer.from('export default { apply() {} };') };
    const built = pack(dir, writePluginSource(dir, 'ok', good, entry.data.toString()), 'ok');
    const tampered = path.join(dir, 'packages', 'tampered.aih-plugin');
    const bytes = fs.readFileSync(built);
    bytes[bytes.length - 3] ^= 0xff;
    fs.writeFileSync(tampered, bytes);
    const truncated = path.join(dir, 'packages', 'truncated.aih-plugin');
    fs.writeFileSync(truncated, fs.readFileSync(built).subarray(0, fs.statSync(built).size - 5));
    const trailing = path.join(dir, 'packages', 'trailing.aih-plugin');
    fs.writeFileSync(trailing, Buffer.concat([fs.readFileSync(built), Buffer.from('x')]));
    const cases = {
      tampered: [tampered, 'plugin_package_digest_mismatch'],
      truncated: [truncated, 'plugin_package_truncated'],
      trailing: [trailing, 'plugin_package_trailing_bytes'],
      traversal: [rawPackage(path.join(dir, 'packages', 'traversal.aih-plugin'), good, [entry, { path: '../escape.js', data: Buffer.from('x') }]), 'plugin_package_path_invalid'],
      reserved: [rawPackage(path.join(dir, 'packages', 'reserved.aih-plugin'), good, [entry, { path: 'lib/con.js', data: Buffer.from('x') }]), 'plugin_package_path_invalid'],
      collision: [rawPackage(path.join(dir, 'packages', 'collision.aih-plugin'), good, [entry, { path: 'A.js', data: Buffer.from('1') }, { path: 'a.js', data: Buffer.from('2') }]), 'plugin_package_path_collision'],
      noEntry: [rawPackage(path.join(dir, 'packages', 'noentry.aih-plugin'), good, [{ path: 'other.mjs', data: Buffer.from('x') }]), 'plugin_entry_missing'],
      notPackage: [path.join(dir, 'packages', 'plain.txt'), 'plugin_package_magic_invalid']
    };
    fs.writeFileSync(cases.notPackage[0], 'hello, not a plugin package');
    const before = control.list().revision;
    for (const [name, [file, code]] of Object.entries(cases)) {
      assert.throws(() => control.install(file), { code }, name);
    }
    assert.equal(control.list().revision, before);
    assert.ok(emptyDir(control.roots.acceptedDir), '坏包不得留下已接受的制品');
    assert.ok(emptyDir(control.roots.extractedDir), '坏包不得留下解压目录');
  });
});

test('packing refuses symlinks inside the plugin directory', { skip: process.platform === 'win32' && '需要创建符号链接的权限' }, () => {
  const dir = tempDir('aihm1-');
  try {
    const source = writePluginSource(dir, 'linky', manifest('aih.test.linky'), 'export default { apply() {} };');
    fs.symlinkSync('/etc/hosts', path.join(source, 'hosts'));
    assert.throws(() => buildArtifact(source, path.join(dir, 'out.aih-plugin')), { code: 'plugin_package_symlink' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 控制面状态 ----

test('plugin state updates are compare-and-swap on the revision', () => {
  const dir = tempDir('aihm1-');
  try {
    const store = createPluginStateStore({ fs, aiHomeDir: dir });
    const first = store.update((state) => state);
    assert.equal(first.revision, 1);
    assert.throws(() => store.update((state) => state, 0), { code: 'plugin_revision_conflict' });
    assert.equal(store.update((state) => state, 1).revision, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 发布协议与生命周期 ----

const CONFIGURED_SOURCE = `export default {
  apply(ctx, config) {
    ctx.aih.register('configured.greet', (value) => config.greeting + ', ' + (value || 'world'));
  }
};`;
const CONFIGURED_MANIFEST = manifest('aih.test.configured', {
  configSchema: {
    type: 'object', additionalProperties: false, required: ['greeting'],
    properties: { greeting: { type: 'string', minLength: 1 } }
  },
  contributes: [{ id: 'configured.greet', capability: 'command', version: 1 }]
});

test('install → configure → enable → invoke → disable, with config validated against the schema', async () => {
  await withSystem(async ({ dir, control, runtime }) => {
    control.install(pack(dir, writePluginSource(dir, 'configured', CONFIGURED_MANIFEST, CONFIGURED_SOURCE), 'configured'));
    assert.equal(runtime.status().host.running, false, '只安装不启用时不启动宿主');

    const before = control.list().revision;
    await assert.rejects(control.enable({ pluginId: 'aih.test.configured', configuration: { greeting: '', extra: 1 } }), { code: 'plugin_config_invalid' });
    assert.equal(control.list().revision, before, '非法配置不改变状态');

    const enabled = await control.enable({ pluginId: 'aih.test.configured', configuration: { greeting: 'hello' } });
    assert.equal(enabled.state, 'active');
    assert.equal((await runtime.invoke('configured.greet', 'aih')).value, 'hello, aih');
    assert.deepEqual(control.list().instances[0].configurationKeys, ['greeting'], '列表只给配置键名');

    await control.disable({ instanceId: 'aih.test.configured' });
    assert.equal(runtime.status().state, 'idle');
    assert.equal(runtime.status().host.running, false, '没有启用实例后宿主停止');
    await assert.rejects(runtime.invoke('configured.greet', 'x'), { code: 'plugin_runtime_inactive' });
  });
});

test('a rejected candidate or a failed commit leaves the current generation serving', async () => {
  await withSystem(async ({ dir, control, runtime }) => {
    control.install(pack(dir, writePluginSource(dir, 'configured', CONFIGURED_MANIFEST, CONFIGURED_SOURCE), 'configured'));
    control.install(pack(dir, writePluginSource(dir, 'broken', manifest('aih.test.broken'), 'export default { apply() { throw new Error("broken at apply"); } };'), 'broken'));
    await control.enable({ pluginId: 'aih.test.configured', configuration: { greeting: 'hi' } });
    const activeBefore = runtime.status().activeGeneration;

    await assert.rejects(control.enable({ pluginId: 'aih.test.broken' }), (error) => {
      assert.equal(error.code, 'plugin_candidate_rejected');
      assert.equal(error.diagnostics[0].code, 'plugin_apply_failed');
      return true;
    });
    assert.equal(runtime.status().activeGeneration, activeBefore);
    assert.equal((await runtime.invoke('configured.greet', 'still')).value, 'hi, still');
    assert.equal(control.list().instances.length, 1, '被拒绝的候选不写入状态');

    // 准备成功但提交冲突（并发写入抢先）：只丢弃候选。
    await assert.rejects(runtime.publish(control.desiredPlugins(), () => { const error = new Error('conflict'); error.code = 'plugin_revision_conflict'; throw error; }),
      { code: 'plugin_revision_conflict' });
    assert.equal(runtime.status().activeGeneration, activeBefore);
    assert.equal((await runtime.invoke('configured.greet', 'after')).value, 'hi, after');

    await assert.rejects(control.enable({ pluginId: 'aih.test.configured', configuration: { greeting: 'x' }, expectedRevision: 0 }), { code: 'plugin_revision_conflict' });
  });
});

test('disabling a plugin stops the timers it registered through ctx.effect', async () => {
  await withSystem(async ({ dir, control }) => {
    const ticks = path.join(dir, 'ticks.log');
    const source = `export default { apply(ctx) {
      ctx.effect(() => { const timer = setInterval(() => require_append(), 20); return () => clearInterval(timer); }, 'ticker');
    } };
    import { appendFileSync } from 'node:fs';
    function require_append() { appendFileSync(${JSON.stringify(ticks)}, '.'); }`;
    control.install(pack(dir, writePluginSource(dir, 'ticker', manifest('aih.test.ticker'), source), 'ticker'));
    await control.enable({ pluginId: 'aih.test.ticker' });
    assert.ok(await waitFor(() => fs.existsSync(ticks) && fs.statSync(ticks).size >= 3), '定时器应在运行');
    await control.disable({ instanceId: 'aih.test.ticker', remove: true });
    const size = fs.statSync(ticks).size;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fs.statSync(ticks).size, size, '停用后定时器不再触发');
  });
});

test('a crashed host is restarted and the enabled plugins are restored', async () => {
  await withSystem(async ({ dir, control, runtime }) => {
    control.install(pack(dir, writePluginSource(dir, 'configured', CONFIGURED_MANIFEST, CONFIGURED_SOURCE), 'configured'));
    await control.enable({ pluginId: 'aih.test.configured', configuration: { greeting: 'back' } });
    const pid = runtime.status().host.pid;
    process.kill(pid, 'SIGKILL');
    assert.ok(await waitFor(() => runtime.status().state === 'active' && runtime.status().host.pid && runtime.status().host.pid !== pid), JSON.stringify(runtime.status()));
    const status = runtime.status();
    assert.equal(status.restarts, 1);
    assert.ok(status.lastExit, '记录上一次退出');
    assert.equal((await runtime.invoke('configured.greet', 'again')).value, 'back, again');
  });
});

test('the host process is recycled after the configured number of generations', async () => {
  await withSystem(async ({ dir, control, runtime }) => {
    control.install(pack(dir, writePluginSource(dir, 'configured', CONFIGURED_MANIFEST, CONFIGURED_SOURCE), 'configured'));
    await control.enable({ pluginId: 'aih.test.configured', configuration: { greeting: 'a' } });
    const firstPid = runtime.status().host.pid;
    await control.enable({ pluginId: 'aih.test.configured', configuration: { greeting: 'b' } });
    assert.equal(runtime.status().host.pid, firstPid);
    await control.enable({ pluginId: 'aih.test.configured', configuration: { greeting: 'c' } });
    assert.notEqual(runtime.status().host.pid, firstPid, '第 3 代前应先回收宿主');
    assert.equal((await runtime.invoke('configured.greet', 'z')).value, 'c, z');
    assert.equal(runtime.status().restarts, 0, '计划内回收不计入崩溃重启');
  }, { recycleAfterGenerations: 2 });
});

test('a plugin version still referenced by an instance cannot be uninstalled', async () => {
  await withSystem(async ({ dir, control }) => {
    control.install(pack(dir, writePluginSource(dir, 'configured', CONFIGURED_MANIFEST, CONFIGURED_SOURCE), 'configured'));
    await control.enable({ pluginId: 'aih.test.configured', configuration: { greeting: 'x' } });
    await control.disable({ instanceId: 'aih.test.configured' });
    assert.throws(() => control.uninstall({ pluginId: 'aih.test.configured' }), { code: 'plugin_in_use' });
    await control.disable({ instanceId: 'aih.test.configured', remove: true });
    control.uninstall({ pluginId: 'aih.test.configured' });
    assert.ok(emptyDir(control.roots.acceptedDir) && emptyDir(control.roots.extractedDir));
    assert.deepEqual(control.list().installed, []);
  });
});

// ---- 经真实 aih server 与 CLI 的闭环 ----

const { startLocalServer } = require('../lib/server/server');
const { createProcessCapture, createServeOptions, createServerDeps, getFreePort } = require('./helpers/local-server-harness');

const MANAGEMENT_KEY = 'management-key-that-is-long-enough';

async function startServer(aiHomeDir, port) {
  const lifecycle = { relayClosed: 0, webrtcClosed: 0, fabricClosed: 0, outboundStopped: 0, logTimers: new Set(), logTimersCleared: 0 };
  const processObj = createProcessCapture();
  const handle = await startLocalServer(createServeOptions(port, { manageProcessLifecycle: false, managementKey: MANAGEMENT_KEY }),
    createServerDeps(aiHomeDir, processObj, lifecycle));
  return handle;
}

// Windows 上 aih server 停止后 app-state.db 仍有句柄未关（服务端既有问题，server-lifecycle 测试同样
// EBUSY），临时目录只能尽力清理；断言不受影响。
function removeServerTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) {
    if (!(process.platform === 'win32' && error.code === 'EBUSY')) throw error;
  }
}

async function cli(args, context) {
  const lines = [];
  const consoleImpl = { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
  const code = await runPluginCommand(['plugin', ...args, '--json'], { ...context, consoleImpl });
  return { code, result: JSON.parse(lines.join('\n')) };
}

test('closed loop through aih server and the CLI survives a server restart', async () => {
  const dir = tempDir('aihm1s-');
  const aiHomeDir = path.join(dir, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const port = await getFreePort();
  const context = { aiHomeDir, serverBaseUrl: `http://127.0.0.1:${port}`, managementKey: MANAGEMENT_KEY };
  let server = await startServer(aiHomeDir, port);
  try {
    // 鉴权：不带密钥 / 错误密钥都拒绝。
    assert.equal((await fetch(`${context.serverBaseUrl}/v0/plugins`)).status, 401);
    assert.equal((await fetch(`${context.serverBaseUrl}/v0/plugins`, { headers: { authorization: 'Bearer wrong' } })).status, 401);

    const packed = await cli(['pack', writePluginSource(dir, 'configured', CONFIGURED_MANIFEST, CONFIGURED_SOURCE), path.join(dir, 'configured.aih-plugin')], context);
    assert.equal(packed.code, 0, JSON.stringify(packed.result));
    const validated = await cli(['validate', path.join(dir, 'src', 'configured'), '--load'], context);
    assert.equal(validated.code, 0, JSON.stringify(validated.result));
    assert.deepEqual(validated.result.loaded.contributions, ['configured.greet']);

    assert.equal((await cli(['install', packed.result.file], context)).code, 0);
    const enabled = await cli(['enable', 'aih.test.configured', '--config-json', '{"greeting":"restored"}'], context);
    assert.equal(enabled.code, 0, JSON.stringify(enabled.result));
    const called = await cli(['call', 'configured.greet', '--value-json', '"cli"'], context);
    assert.equal(called.result.value, 'restored, cli');

    await server.stop();
    server = await startServer(aiHomeDir, port);
    let listed = null;
    assert.ok(await waitFor(async () => {
      listed = (await cli(['list'], context)).result;
      return listed.runtime?.state === 'active';
    }), JSON.stringify(listed));
    assert.equal((await cli(['call', 'configured.greet', '--value-json', '"again"'], context)).result.value, 'restored, again');

    const disabled = await cli(['disable', 'aih.test.configured'], context);
    assert.equal(disabled.code, 0);
    const doctor = await cli(['doctor'], context);
    assert.equal(doctor.result.healthy, true, JSON.stringify(doctor.result));
  } finally {
    await server.stop();
    removeServerTempDir(dir);
  }
});

test('the CLI reports an unreachable server instead of starting its own host', async () => {
  const dir = tempDir('aihm1c-');
  try {
    const port = await getFreePort();
    const outcome = await cli(['list'], { aiHomeDir: dir, serverBaseUrl: `http://127.0.0.1:${port}`, managementKey: MANAGEMENT_KEY });
    assert.equal(outcome.code, 1);
    assert.equal(outcome.result.error, 'plugin_server_unreachable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 插件安装 = 以服务端身份执行任意代码：没配管理密钥时一律 503，不走 /v0/management 的本机免密放行。
test('plugin routes require a configured management key even from loopback', async () => {
  const { handlePluginManagementRequest } = require('../lib/server/plugin-management-routes');
  const written = [];
  const handled = await handlePluginManagementRequest({
    method: 'GET', pathname: '/v0/plugins',
    req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    res: {}, requiredManagementKey: '', state: {},
    deps: { writeJson: (_res, status, body) => written.push({ status, body }), aiHomeDir: tempDir('aihm1r-') }
  });
  assert.equal(handled, true);
  assert.equal(written[0].status, 503);
  assert.equal(written[0].body.error, 'management_key_not_configured');
  assert.equal(await handlePluginManagementRequest({ method: 'GET', pathname: '/v0/pluginsx', req: {}, res: {}, deps: {} }), false);
});
