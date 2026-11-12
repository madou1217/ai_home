'use strict';

// 端到端：真实 Node 插件路由 → 独立 Go 进程（testdata/plugincontrolserver）→
// 真实 app-state.db / artifacts / 维护租约 → Node control 读同一份状态。
//
// 只使用 temp AIH_HOME_DIR，不碰生产 HOME。若本机没有 go 工具链则跳过。

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { handlePluginManagementRequest } = require('../lib/server/plugin-management-routes');
const { buildArtifact } = require('../lib/plugins/control/artifact');
const { addTrustedKey } = require('../lib/plugins/control/signature');
const { createPluginControl } = require('../lib/plugins/control/control');
const { createGoManagementClient } = require('../lib/account/go-bridge/go-management-client');
const packageVersion = require('../package.json').version;

const REPO_ROOT = path.resolve(__dirname, '..');
const MANAGEMENT_KEY = 'e2e-plugin-artifact-key';

function bodyStream(body) {
  return {
    async *[Symbol.asyncIterator]() {
      if (body === undefined) return;
      yield Buffer.from(JSON.stringify(body), 'utf8');
    }
  };
}

function createCtx({ method, pathname, body, deps, home }) {
  const writes = [];
  return {
    writes,
    ctx: {
      method,
      pathname,
      req: {
        url: pathname,
        headers: { authorization: 'Bearer ' + MANAGEMENT_KEY },
        ...bodyStream(body)
      },
      res: {},
      state: {},
      requiredManagementKey: MANAGEMENT_KEY,
      deps: {
        writeJson: (_res, status, payload) => writes.push({ status, payload }),
        aiHomeDir: home,
        ...deps
      }
    }
  };
}

async function startGoServer(t, home) {
  const binary = path.join(t.tmpDir, process.platform === 'win32' ? 'plugincontrolserver.exe' : 'plugincontrolserver');
  const build = spawnSync('go', ['build', '-o', binary, './testdata/plugincontrolserver'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000
  });
  assert.equal(build.status, 0, build.stderr || 'go build 失败');
  const child = spawn(binary, [], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AIH_PLUGIN_TEST_KEY: MANAGEMENT_KEY,
      AIH_PLUGIN_TEST_HOME: home
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  t.after(() => { try { child.kill('SIGKILL'); } catch (_error) {} });
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
  return 'http://' + address;
}

function createGoHost(baseUrl) {
  const client = createGoManagementClient({
    baseUrl,
    managementKey: MANAGEMENT_KEY,
    hostVersion: packageVersion,
    nodeVersion: process.versions.node
  });
  return {
    installPlugin: (payload) => client.installPlugin(payload),
    uninstallPlugin: (payload) => client.uninstallPlugin(payload),
    getPluginInventory: () => client.getPluginInventory()
  };
}

function writePluginSource(t) {
  const source = path.join(t.tmpDir, 'source');
  fs.mkdirSync(source, { recursive: true });
  const manifest = {
    manifestVersion: 1,
    protocolVersion: 1,
    pluginId: 'aih.e2e.echo',
    version: '1.0.0',
    engines: { aih: '>=1.0.0', node: '>=22' },
    runtime: 'node',
    entry: 'index.mjs',
    targets: ['any'],
    contributes: [
      { id: 'aih.e2e.echo.run', capability: 'command', version: 1 }
    ],
    provides: [{ name: 'e2e.echo', version: '1.0.0' }],
    permissions: {
      network: ['https://api.example.com'],
      filesystem: { read: ['state'], write: ['state'] },
      secrets: ['api_key']
    }
  };
  fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(source, 'index.mjs'), 'export default {};\n');
  return source;
}

test('Node install route -> Go artifact/state -> Node control read -> uninstall', { timeout: 180000 }, async (t) => {
  if (spawnSync('go', ['version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('本机没有 go 工具链');
    return;
  }
  t.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-plugin-artifact-e2e-'));
  t.after(() => { try { fs.rmSync(t.tmpDir, { recursive: true, force: true }); } catch (_error) {} });
  const home = path.join(t.tmpDir, 'home');
  fs.mkdirSync(home, { recursive: true });

  // 1) 用 Node 的 buildArtifact 生成真实签名包，并用 Node 的信任根写入公钥。
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const keyId = 'e2e-key';
  addTrustedKey(home, { publicKey: publicPem, keyId });
  const artifactFile = path.join(t.tmpDir, 'plugin.aih-plugin');
  const built = buildArtifact(writePluginSource(t), artifactFile, { signingKey: privatePem, keyId });
  assert.equal(built.signature.status, 'signed');

  // 2) 独立 Go 进程 + 真实管理客户端。
  const baseUrl = await startGoServer(t, home);
  const goHost = createGoHost(baseUrl);

  // 3) 真实 Node 路由安装。
  const install = createCtx({
    method: 'POST',
    pathname: '/v0/plugins/install',
    body: { file: artifactFile },
    deps: { goCoreSync: goHost },
    home
  });
  await handlePluginManagementRequest(install.ctx);
  assert.equal(install.writes.length, 1);
  const installed = install.writes[0].payload;
  assert.equal(install.writes[0].status, 200, JSON.stringify(installed));
  assert.equal(installed.ok, true);
  assert.equal(installed.pluginId, 'aih.e2e.echo');
  assert.equal(installed.version, '1.0.0');
  assert.equal(installed.digest, built.digest);
  assert.equal(installed.signature.status, 'signed');
  assert.equal(installed.signature.keyId, keyId);

  // 4) Node control 直接读 Go 写入的记录（同一份 app-state.db）。
  const control = createPluginControl({ aiHomeDir: home, hostVersion: packageVersion });
  const state = control.store.get();
  assert.equal(state.installed.length, 1);
  const record = state.installed[0];
  assert.equal(record.pluginId, 'aih.e2e.echo');
  assert.equal(record.version, '1.0.0');
  assert.equal(record.digest, built.digest);
  assert.equal(record.signature.status, 'signed');
  assert.equal(record.manifest.entry, 'index.mjs');
  assert.ok(fs.existsSync(record.artifact), '制品文件应存在');
  assert.ok(fs.existsSync(path.join(record.directory, 'index.mjs')), '解压入口应存在');
  // 指纹必须能被 Node 复算出来：enable 时的 permissionsAcceptedFingerprint 依赖它。
  const expectedFingerprint = crypto.createHash('sha256')
    .update(JSON.stringify(record.manifest.permissions))
    .digest('hex')
    .slice(0, 16);
  assert.equal(record.permissionsFingerprint, expectedFingerprint);
  // doctor 用的清单校验也要能读：Go 写回的清单必须仍是合法清单。
  assert.equal(control.doctor().issues.length, 0);

  // 5) 列表走 Go 只读清单。
  const list = createCtx({ method: 'GET', pathname: '/v0/plugins', deps: { goCoreSync: goHost }, home });
  await handlePluginManagementRequest(list.ctx);
  assert.equal(list.writes[0].status, 200);
  assert.equal(list.writes[0].payload.revision, installed.revision);
  assert.equal(list.writes[0].payload.installed[0].pluginId, 'aih.e2e.echo');

  // 6) 真实 Node 路由卸载。
  const uninstall = createCtx({
    method: 'POST',
    pathname: '/v0/plugins/uninstall',
    body: { pluginId: 'aih.e2e.echo', version: '1.0.0', expectedRevision: installed.revision },
    deps: { goCoreSync: goHost },
    home
  });
  await handlePluginManagementRequest(uninstall.ctx);
  assert.equal(uninstall.writes[0].status, 200, JSON.stringify(uninstall.writes[0].payload));
  assert.equal(uninstall.writes[0].payload.revision, installed.revision + 1);

  // 7) 状态与文件都清干净；审计仍由 Node 写。
  const after = createPluginControl({ aiHomeDir: home, hostVersion: packageVersion }).store.get();
  assert.equal(after.installed.length, 0);
  assert.equal(fs.existsSync(record.artifact), false, '卸载后制品应删除');
  assert.equal(fs.existsSync(record.directory), false, '卸载后解压目录应删除');
  const auditFile = path.join(home, 'plugins', 'audit.log');
  const events = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.event), ['install', 'uninstall']);
  assert.equal(events[0].digest, built.digest);
  assert.equal(events[0].keyId, keyId);
});
