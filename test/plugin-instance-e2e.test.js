'use strict';

// P2 端到端：独立 Go 进程（testdata/plugincontrolserver）→ 真实 Node 内部发布路由
// （fake runtime host）→ 真实 app-state.db。
//
// 覆盖：enable（revision+1、generation 返回）→ disable（空状态）→ Go 停掉后公开 disable 503
// 且 revision 不变。只使用 temp HOME；没有 go 工具链时跳过。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const { handlePluginManagementRequest } = require('../lib/server/plugin-management-routes');
const { getPluginSystem } = require('../lib/plugins/control/plugin-system');
const { createPluginStateStore } = require('../lib/plugins/control/state-store');
const { writeJsonValue, readJsonValue } = require('../lib/server/app-state-store');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANAGEMENT_KEY = 'e2e-plugin-instance-key';
const STATE_KEY = 'plugins.control.v1';

function writeJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function createFakeSupervisor() {
  const calls = [];
  return {
    calls,
    async call(method, payload) {
      calls.push({ method, payload });
      if (method === 'prepare') return { value: { state: 'prepared', contributions: [{ id: 'echo.reply' }] } };
      if (method === 'activate') return { value: { state: 'active' } };
      if (method === 'dispose') return { value: { state: 'disposed' } };
      if (method === 'invoke') return { value: null };
      throw new Error(`unexpected host call: ${method}`);
    },
    status: () => ({ running: true, pid: 777 }),
    async stop() {}
  };
}

function seedState(home) {
  const pluginRoot = path.join(home, 'plugins');
  const state = {
    schemaVersion: 1,
    revision: 1,
    installed: [{
      pluginId: 'echo',
      version: '1.0.0',
      digest: 'digest-e2e',
      artifact: path.join(pluginRoot, 'accepted', 'digest-e2e.aih-plugin'),
      directory: path.join(pluginRoot, 'extracted', 'digest-e2e'),
      manifest: {
        pluginId: 'echo',
        version: '1.0.0',
        entry: 'index.js',
        contributes: [{ id: 'echo.reply', capability: 'gateway.request' }],
        permissions: { network: [], filesystem: { read: [], write: [] }, secrets: [], environment: [] }
      },
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

function goCoreClient(baseUrl) {
  const request = async (instanceId, operation, body) => {
    try {
      const response = await fetch(`${baseUrl}/v1/management/plugins/instances/${encodeURIComponent(instanceId)}/${operation}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${MANAGEMENT_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body || {})
      });
      const text = await response.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_error) {}
      return { ok: response.ok, status: response.status, body: json, data: json };
    } catch (_error) {
      return { ok: false, status: 0, body: null, data: null, errorCode: 'network_error' };
    }
  };
  return {
    enablePlugin: (instanceId, body) => request(instanceId, 'enable', body),
    disablePlugin: (instanceId, body) => request(instanceId, 'disable', body),
    getPluginInventory: async () => {
      try {
        const response = await fetch(`${baseUrl}/v1/management/plugins`, {
          headers: { authorization: `Bearer ${MANAGEMENT_KEY}` }
        });
        const text = await response.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_error) {}
        return { ok: response.ok, status: response.status, data: json, body: json };
      } catch (_error) {
        return { ok: false, status: 0, data: null, body: null };
      }
    }
  };
}

async function startNodeInternalServer(home, state, goCoreSync) {
  const system = getPluginSystem(state, {
    aiHomeDir: home,
    stateStore: createPluginStateStore({ fs, aiHomeDir: home }),
    supervisorFactory: () => createFakeSupervisor(),
    providerDescriptorSync: false
  });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    handlePluginManagementRequest({
      method: req.method,
      pathname,
      req,
      res,
      state,
      requiredManagementKey: MANAGEMENT_KEY,
      deps: {
        writeJson,
        aiHomeDir: home,
        goCoreSync
      }
    }).catch((error) => {
      writeJson(res, 500, { ok: false, error: 'internal_test_error', message: error.message });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, system, address: `http://127.0.0.1:${server.address().port}` };
}

async function startGoServer(tmpDir, home, nodeUrl) {
  const binary = path.join(tmpDir, process.platform === 'win32' ? 'plugincontrolserver.exe' : 'plugincontrolserver');
  const build = spawnSync('go', ['build', '-o', binary, './testdata/plugincontrolserver'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000
  });
  if (build.error && build.error.code === 'ENOENT') return null;
  assert.equal(build.status, 0, build.stderr || 'go build 失败');
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

test('Go 实例端点 → Node 内部 prepare/activate → 真实状态：enable/disable/Go 停止', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-plugin-instance-e2e-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = {};
  seedState(home);

  // 先起 Node 内部服务；Go 的公开端口未知时先用占位，goCoreSync 在请求期读 baseUrl。
  let goBaseUrl = null;
  const goCoreSync = {
    enablePlugin: (instanceId, body) => goCoreClient(goBaseUrl).enablePlugin(instanceId, body),
    disablePlugin: (instanceId, body) => goCoreClient(goBaseUrl).disablePlugin(instanceId, body)
  };
  const node = await startNodeInternalServer(home, state, goCoreSync);
  t.after(() => new Promise((resolve) => node.server.close(resolve)));

  const go = await startGoServer(fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-build-')), home, node.address);
  if (!go) {
    t.skip('本机没有 go 工具链');
    return;
  }
  goBaseUrl = go.baseUrl;
  let exited = false;
  t.after(async () => {
    if (!exited) {
      try { go.child.kill('SIGKILL'); } catch (_error) {}
      await once(go.child, 'exit').catch(() => {});
    }
  });

  const client = goCoreClient(go.baseUrl);
  const enabled = await client.enablePlugin('echo', {
    pluginId: 'echo',
    acceptPermissions: true,
    expectedRevision: 1
  });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(enabled.body.ok, true);
  assert.equal(enabled.body.revision, 2);
  assert.ok(enabled.body.generation >= 1);
  assert.equal(enabled.body.state, 'active');

  const afterEnable = readJsonValue(fs, home, STATE_KEY, { bestEffort: false });
  assert.equal(afterEnable.revision, 2);
  assert.equal(afterEnable.instances.find((item) => item.instanceId === 'echo').enabled, true);

  const inventory = await client.getPluginInventory();
  assert.equal(inventory.status, 200);
  assert.equal(inventory.data.revision, 2);
  assert.equal(inventory.data.instances.find((item) => item.instanceId === 'echo').enabled, true);

  const disabled = await client.disablePlugin('echo', { expectedRevision: 2 });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  assert.equal(disabled.body.revision, 3);
  assert.equal(disabled.body.generation, 0);
  assert.equal(disabled.body.state, 'idle');
  const afterDisable = readJsonValue(fs, home, STATE_KEY, { bestEffort: false });
  assert.equal(afterDisable.revision, 3);
  assert.equal(afterDisable.instances.find((item) => item.instanceId === 'echo').enabled, false);

  // Go 停掉：Node 公开入口代理失败并返回 503，状态保持不变。
  go.child.kill('SIGKILL');
  await once(go.child, 'exit');
  exited = true;
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
  const afterFailure = readJsonValue(fs, home, STATE_KEY, { bestEffort: false });
  assert.equal(afterFailure.revision, 3);
  assert.equal(afterFailure.instances.find((item) => item.instanceId === 'echo').enabled, false);
});
