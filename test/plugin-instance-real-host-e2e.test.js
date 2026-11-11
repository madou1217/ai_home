'use strict';

// P2 真实宿主端到端：独立 Go 进程（testdata/plugincontrolserver）→ Node 内部发布路由
// → 真实 Plugin Host 子进程（supervisor 拉起 host-entry.mjs，不 mock invoke）→ 真实 app-state.db
// → Go 投影接口（探活宿主后确认代次）→ 只读清单读回 projected。
//
// 与 plugin-instance-e2e.test.js 的分工：那边用 fake runtime host 锁发布状态机，跑得快；
// 这里验证「真宿主真的能加载入口模块、真的被探活确认、停用后真的退出且不留 socket/进程」。
//
// 只使用 temp HOME（/tmp 短路径，unix socket 有长度上限）和独立随机端口，不碰生产 HOME/9527。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const { handlePluginManagementRequest } = require('../lib/server/plugin-management-routes');
const { attachGoProjection, getPluginSystem } = require('../lib/plugins/control/plugin-system');
const { createPluginStateStore } = require('../lib/plugins/control/state-store');
const { writeJsonValue, readJsonValue } = require('../lib/server/app-state-store');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANAGEMENT_KEY = 'e2e-plugin-real-host-key';
const STATE_KEY = 'plugins.control.v1';
const ECHO_SOURCE = path.join(REPO_ROOT, 'examples', 'plugins', 'echo');

function writeJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

// unix socket 路径受 104 字节限制：temp HOME 放 /tmp（macOS 的 os.tmpdir 在 /var/folders 下太长）。
function makeHome() {
  const base = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  return fs.mkdtempSync(path.join(base, 'aih-plugin-host-'));
}

// 真实安装布局：制品目录在 HOME 下，入口由 installed.directory + manifest.entry 推出。
function seedState(home) {
  const directory = path.join(home, 'plugins', 'extracted', 'digest-real-host');
  fs.cpSync(ECHO_SOURCE, directory, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'plugin.json'), 'utf8'));
  const state = {
    schemaVersion: 1,
    revision: 1,
    installed: [{
      pluginId: manifest.pluginId,
      version: manifest.version,
      digest: 'digest-real-host',
      artifact: path.join(home, 'plugins', 'accepted', 'digest-real-host.aih-plugin'),
      directory,
      manifest,
      installedAt: Date.now(),
      signature: { status: 'unsigned' },
      permissionsFingerprint: ''
    }],
    instances: [],
    generations: [],
    activeGeneration: 0
  };
  assert.equal(writeJsonValue(fs, home, STATE_KEY, state, { createIfMissing: true }), true);
  return state;
}

async function readJsonBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_error) { return null; }
}

function goCoreClient(baseUrl) {
  const call = async (method, pathname, body) => {
    try {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${MANAGEMENT_KEY}`,
          'content-type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const json = await readJsonBody(response);
      return { ok: response.ok, status: response.status, body: json, data: json };
    } catch (_error) {
      return { ok: false, status: 0, body: null, data: null, errorCode: 'network_error' };
    }
  };
  return {
    enablePlugin: (instanceId, body) => call('POST', `/v1/management/plugins/instances/${encodeURIComponent(instanceId)}/enable`, body || {}),
    disablePlugin: (instanceId, body) => call('POST', `/v1/management/plugins/instances/${encodeURIComponent(instanceId)}/disable`, body || {}),
    getPluginInventory: () => call('GET', '/v1/management/plugins'),
    // Go 投影是整体替换：Node 每次推送全部存活代次（空数组 = 清空）。
    pushPluginProjection: (payload) => call('PUT', '/v1/management/plugins/projection', payload)
  };
}

function startNodeInternalServer(home, state, goCoreSync) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    handlePluginManagementRequest({
      method: req.method,
      pathname,
      req,
      res,
      state,
      requiredManagementKey: MANAGEMENT_KEY,
      deps: { writeJson, aiHomeDir: home, goCoreSync }
    }).catch((error) => {
      writeJson(res, 500, { ok: false, error: 'internal_test_error', message: error.message });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, address: `http://127.0.0.1:${server.address().port}` }));
  });
}

function buildGoServer(tmpDir) {
  const binary = path.join(tmpDir, process.platform === 'win32' ? 'plugincontrolserver.exe' : 'plugincontrolserver');
  const build = spawnSync('go', ['build', '-o', binary, './testdata/plugincontrolserver'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000
  });
  if (build.error && build.error.code === 'ENOENT') return null;
  assert.equal(build.status, 0, build.stderr || 'go build 失败');
  return binary;
}

async function startGoServer(binary, home, nodeUrl) {
  const child = spawn(binary, [], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AIH_PLUGIN_TEST_KEY: MANAGEMENT_KEY,
      AIH_PLUGIN_TEST_HOME: home,
      AIH_PLUGIN_TEST_NODE_URL: nodeUrl
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const address = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('Go 插件服务启动超时: ' + stderr)), 15000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const match = /LISTEN=(\S+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Go 插件服务提前退出: ' + code + ' ' + stderr));
    });
  });
  return { child, baseUrl: 'http://' + address };
}

async function waitFor(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`);
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

test('真实 Plugin Host：enable 后实例 projected，disable 后宿主退出且无残留，Go 停掉后 503 不改状态', { timeout: 180000 }, async (t) => {
  const home = makeHome();
  const cleanup = { projection: null, system: null, server: null, goChild: null, goExited: false };
  t.after(async () => {
    try { cleanup.projection?.stop(); } catch (_error) {}
    try { await cleanup.system?.runtime.stop(); } catch (_error) {}
    const pid = Number(cleanup.system?.runtime.status().host.pid || 0);
    if (pid && isProcessAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (_error) {}
    }
    if (cleanup.server) await new Promise((resolve) => cleanup.server.close(resolve));
    if (cleanup.goChild && !cleanup.goExited) {
      try { cleanup.goChild.kill('SIGKILL'); } catch (_error) {}
      await once(cleanup.goChild, 'exit').catch(() => {});
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  seedState(home);
  const state = {};

  // 真实插件系统：不注入 supervisorFactory，走 supervisor.js 拉起的真宿主子进程。
  const system = getPluginSystem(state, {
    aiHomeDir: home,
    stateStore: createPluginStateStore({ fs, aiHomeDir: home }),
    providerDescriptorSync: false
  });
  cleanup.system = system;

  let goBaseUrl = null;
  const goCoreSync = {
    enablePlugin: (instanceId, body) => goCoreClient(goBaseUrl).enablePlugin(instanceId, body),
    disablePlugin: (instanceId, body) => goCoreClient(goBaseUrl).disablePlugin(instanceId, body),
    getPluginInventory: () => goCoreClient(goBaseUrl).getPluginInventory()
  };
  const node = await startNodeInternalServer(home, state, goCoreSync);
  cleanup.server = node.server;

  const binary = buildGoServer(home);
  if (!binary) {
    t.skip('本机没有 go 工具链');
    return;
  }
  const go = await startGoServer(binary, home, node.address);
  cleanup.goChild = go.child;
  goBaseUrl = go.baseUrl;
  const client = goCoreClient(go.baseUrl);

  // Node → Go 的存活代次投影。Go 会先拨号 ping 真实宿主，确认后才接受到清单里。
  cleanup.projection = attachGoProjection(system, (payload) => client.pushPluginProjection(payload), { intervalMs: 1000 });

  // —— 启用：Go 读 revision → Node 真宿主 prepare → Go CAS 提交 → Node activate ——
  const enabled = await client.enablePlugin('echo', {
    pluginId: 'aih.sample.echo',
    instanceId: 'echo',
    acceptPermissions: true,
    expectedRevision: 1
  });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(enabled.body.ok, true);
  assert.equal(enabled.body.revision, 2);
  assert.equal(enabled.body.generation, 1);
  assert.equal(enabled.body.state, 'active');

  const afterEnable = readJsonValue(fs, home, STATE_KEY, { bestEffort: false });
  assert.equal(afterEnable.revision, 2);
  assert.equal(afterEnable.instances.find((item) => item.instanceId === 'echo').enabled, true);

  // 运行时：活跃代次由真宿主准备并激活；贡献项来自 echo 入口实际注册的 handler。
  const runtimeAfterEnable = system.runtime.status();
  assert.equal(runtimeAfterEnable.state, 'active');
  assert.equal(runtimeAfterEnable.activeGeneration, 1);
  assert.deepEqual(runtimeAfterEnable.contributions, ['sample.echo.call', 'sample.echo.stats', 'sample.echo.wait']);
  assert.equal(runtimeAfterEnable.host.running, true);
  assert.ok(runtimeAfterEnable.host.pid > 0, '宿主进程应真实存在');
  assert.deepEqual(runtimeAfterEnable.retiringGenerations, []);
  assert.deepEqual(runtimeAfterEnable.leases, {});
  // 进程存活是「宿主没在 prepare 后偷偷退出」的直接证据。
  assert.equal(isProcessAlive(runtimeAfterEnable.host.pid), true);
  const hostPid = runtimeAfterEnable.host.pid;
  const socketPath = runtimeAfterEnable.host.socketPath;
  assert.ok(fs.existsSync(socketPath), '宿主 socket 应存在');

  // 实例投影：Node 侧存活代次快照包含 echo 的三个贡献项。
  const projections = system.runtime.liveProjections();
  assert.equal(projections.length, 1);
  assert.equal(projections[0].generation, 1);
  assert.deepEqual(projections[0].contributions.map((item) => item.id).sort(),
    ['sample.echo.call', 'sample.echo.stats', 'sample.echo.wait']);
  assert.ok(projections[0].contributions.every((item) => item.instanceId === 'echo'));

  // 真的调一次入口 handler：证明代次里跑的是插件代码，不是被 mock 掉的空壳。
  const invoked = await system.runtime.invoke('sample.echo.call', { hello: 'real-host' }, { generation: 1 });
  assert.deepEqual(invoked.value.echoed, { hello: 'real-host' });
  assert.equal(invoked.value.generation, 1);
  assert.equal(invoked.value.instanceId, 'echo');

  // Go 侧：投影推送被真实探活确认后，清单的 runtime 才是 projected。
  const inventoryAfterEnable = await waitFor(async () => {
    const response = await client.getPluginInventory();
    if (!response.ok) return null;
    return response.data?.runtime?.activeGeneration === 1 ? response : null;
  }, 'Go 确认代次投影');
  assert.equal(inventoryAfterEnable.data.readOnly, true);
  assert.equal(inventoryAfterEnable.data.revision, 2);
  assert.deepEqual(inventoryAfterEnable.data.runtime.generations, [1]);
  assert.deepEqual(inventoryAfterEnable.data.runtime.retiringGenerations, []);
  const projectedInstance = inventoryAfterEnable.data.runtime.instances.find((item) => item.instanceId === 'echo');
  assert.ok(projectedInstance, '清单应包含 echo 实例');
  assert.equal(projectedInstance.status, 'projected');
  // Go 的实例代次按贡献项展开（同一代次会重复出现），这里只核事实：实例确实在代次 1。
  assert.deepEqual([...new Set(projectedInstance.generations)], [1]);
  assert.equal(projectedInstance.contributions, 3);
  assert.equal(inventoryAfterEnable.data.consistency.ok, true);

  // 公开清单（Node /v0/plugins）只做字段映射，运行态必须与 Go 一致。
  const publicInventory = await fetch(`${node.address}/v0/plugins`, {
    headers: { authorization: `Bearer ${MANAGEMENT_KEY}` }
  });
  assert.equal(publicInventory.status, 200);
  const publicBody = await publicInventory.json();
  assert.equal(publicBody.runtime.activeGeneration, 1);
  assert.deepEqual(publicBody.runtime.generations, [1]);
  assert.equal(publicBody.runtime.instances.find((item) => item.instanceId === 'echo').status, 'projected');

  // —— 停用：空集合票据 → 状态提交 → 宿主停止并卸载代次 ——
  const disabled = await client.disablePlugin('echo', { expectedRevision: 2 });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  assert.equal(disabled.body.revision, 3);
  assert.equal(disabled.body.generation, 0);
  assert.equal(disabled.body.state, 'idle');

  const afterDisable = readJsonValue(fs, home, STATE_KEY, { bestEffort: false });
  assert.equal(afterDisable.revision, 3);
  assert.equal(afterDisable.instances.find((item) => item.instanceId === 'echo').enabled, false);
  // 控制面文档里的运行态字段不允许残留（停用后不存在任何代次）。
  assert.equal(afterDisable.activeGeneration, 0);
  assert.deepEqual(afterDisable.generations, []);

  const runtimeAfterDisable = system.runtime.status();
  assert.equal(runtimeAfterDisable.state, 'idle');
  assert.equal(runtimeAfterDisable.activeGeneration, 0);
  assert.deepEqual(runtimeAfterDisable.contributions, []);
  assert.deepEqual(runtimeAfterDisable.retiringGenerations, []);
  assert.deepEqual(runtimeAfterDisable.leases, {});
  assert.deepEqual(system.runtime.liveProjections(), []);
  // 宿主：进程退出、socket 被清理、退出码干净——三项都查，避免只看 supervisor 自己的标志位。
  assert.equal(runtimeAfterDisable.host.running, false);
  assert.equal(runtimeAfterDisable.host.pid, 0);
  assert.equal(runtimeAfterDisable.host.lastExit?.code, 0);
  assert.equal(isProcessAlive(hostPid), false, '停用后宿主进程必须退出');
  assert.equal(fs.existsSync(socketPath), false, '停用后宿主 socket 必须被清理');

  const inventoryAfterDisable = await waitFor(async () => {
    const response = await client.getPluginInventory();
    if (!response.ok) return null;
    return (response.data?.runtime?.generations || []).length === 0 ? response : null;
  }, 'Go 清空代次投影');
  assert.equal(inventoryAfterDisable.data.revision, 3);
  assert.equal(inventoryAfterDisable.data.runtime.activeGeneration, 0);
  assert.deepEqual(inventoryAfterDisable.data.runtime.generations, []);
  assert.deepEqual(inventoryAfterDisable.data.runtime.retiringGenerations, []);
  const absentInstance = inventoryAfterDisable.data.runtime.instances.find((item) => item.instanceId === 'echo');
  assert.equal(absentInstance.status, 'absent');
  assert.equal(absentInstance.contributions, 0);
  assert.equal(inventoryAfterDisable.data.consistency.ok, true);

  // —— Go 停掉：公开入口代理失败 503，状态与运行态都不变 ——
  go.child.kill('SIGKILL');
  await once(go.child, 'exit');
  cleanup.goExited = true;

  const failed = await new Promise((resolve, reject) => {
    const request = http.request(`${node.address}/v0/plugins/disable`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${MANAGEMENT_KEY}`,
        'content-type': 'application/json'
      }
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(JSON.stringify({ instanceId: 'echo' }));
  });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error, 'go_core_unavailable');
  const afterGoDown = readJsonValue(fs, home, STATE_KEY, { bestEffort: false });
  assert.equal(afterGoDown.revision, 3);
  assert.equal(afterGoDown.instances.find((item) => item.instanceId === 'echo').enabled, false);
  // Node 没有因为入口 503 而本地兜底：宿主仍停着，没有任何代次被重新拉起来。
  assert.equal(system.runtime.status().activeGeneration, 0);
  assert.equal(system.runtime.status().host.running, false);
});
