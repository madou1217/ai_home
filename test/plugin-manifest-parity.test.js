'use strict';

// 跨语言对拍：同一批 fixture 分别跑 Node 的 validateManifest/permissionFingerprint
// 与 Go 的安装校验（testdata/manifestvalidator），accept/reject 结论、错误码与
// permissionsFingerprint 必须逐字节一致。避免只靠手写期望值。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { validateManifest } = require('../lib/plugins/sdk/manifest');
const { permissionFingerprint } = require('../lib/plugins/control/control');

const REPO_ROOT = path.resolve(__dirname, '..');
const OPTIONS = { hostVersion: '1.0.0', nodeVersion: '22.14.0', target: 'darwin-arm64' };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseManifest() {
  return {
    manifestVersion: 1,
    protocolVersion: 1,
    pluginId: 'aih.parity.echo',
    version: '1.0.0',
    engines: { aih: '>=1.0.0' },
    runtime: 'node',
    entry: 'index.mjs',
    contributes: [{ id: 'aih.parity.echo.run', capability: 'command', version: 1 }]
  };
}

function fixtures() {
  const legal = baseManifest();
  const permissions = clone(legal);
  permissions.permissions = {
    network: ['https://api.example.com'],
    filesystem: { read: ['state'], write: ['state'] },
    secrets: ['api_key']
  };
  const permissionOrder = clone(permissions);
  permissionOrder.permissions = {
    secrets: ['api_key'],
    filesystem: { write: ['state'], read: ['state'] },
    network: ['https://api.example.com']
  };
  const withEnvironment = clone(permissions);
  withEnvironment.permissions.environment = ['HTTPS_PROXY'];
  const anyTarget = clone(legal);
  anyTarget.targets = ['any'];
  const missingEntry = clone(legal);
  delete missingEntry.entry;
  const hostIncompatible = clone(legal);
  hostIncompatible.engines = { aih: '>=2.0.0' };
  const nodeIncompatible = clone(legal);
  nodeIncompatible.engines = { aih: '>=1.0.0', node: '>=24' };
  const platformIncompatible = clone(legal);
  platformIncompatible.targets = ['linux-x64'];
  const badNetwork = clone(permissions);
  badNetwork.permissions.network = ['https://api.example.com?token=1'];
  const accountWithoutPermissions = clone(legal);
  accountWithoutPermissions.contributes = [{ id: 'aih.parity.echo.login', capability: 'account.login', version: 1 }];
  const badConfigSchema = clone(legal);
  badConfigSchema.configSchema = { type: 'object', format: 'email' };
  const duplicateContribution = clone(legal);
  duplicateContribution.contributes = [
    { id: 'aih.parity.echo.run', capability: 'command', version: 1 },
    { id: 'aih.parity.echo.run', capability: 'command', version: 1 }
  ];
  const unknownCapability = clone(legal);
  unknownCapability.contributes = [{ id: 'aih.parity.echo.run', capability: 'no.such', version: 1 }];
  const invalidEntry = clone(legal);
  invalidEntry.entry = '/index.mjs';
  const invalidVersion = clone(legal);
  invalidVersion.version = '1.0';
  const extraField = clone(legal);
  extraField.extra = true;
  return [
    { name: '合法最小清单', manifest: legal },
    { name: '合法权限（无 environment）', manifest: permissions },
    { name: '合法权限（键序打乱）', manifest: permissionOrder },
    { name: '合法权限（含 environment）', manifest: withEnvironment },
    { name: '合法 targets any', manifest: anyTarget },
    { name: '缺 entry', manifest: missingEntry },
    { name: '宿主版本不兼容', manifest: hostIncompatible },
    { name: 'Node 版本不兼容', manifest: nodeIncompatible },
    { name: '平台不兼容', manifest: platformIncompatible },
    { name: '网络权限非法', manifest: badNetwork },
    { name: '账号能力缺权限', manifest: accountWithoutPermissions },
    { name: 'configSchema 非法', manifest: badConfigSchema },
    { name: '贡献项重复', manifest: duplicateContribution },
    { name: '未知能力', manifest: unknownCapability },
    { name: '入口绝对路径', manifest: invalidEntry },
    { name: '版本号非法', manifest: invalidVersion },
    { name: '清单多余字段', manifest: extraField }
  ];
}

function runNodeValidation(manifest) {
  try {
    const normalized = validateManifest(clone(manifest), OPTIONS);
    return { ok: true, fingerprint: permissionFingerprint(normalized) };
  } catch (error) {
    return { ok: false, code: error && error.code ? String(error.code) : 'plugin_error' };
  }
}

test('Node 与 Go 的 manifest 校验/权限指纹逐字节一致', { timeout: 120000 }, (t) => {
  if (spawnSync('go', ['version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('本机没有 go 工具链');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-manifest-parity-'));
  t.after(() => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch (_error) {} });
  const binary = path.join(directory, 'manifestvalidator');
  const build = spawnSync('go', ['build', '-o', binary, './testdata/manifestvalidator'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000
  });
  assert.equal(build.status, 0, build.stderr || 'go build 失败');

  const cases = fixtures();
  const input = cases.map((item) => JSON.stringify({ manifest: item.manifest, options: OPTIONS })).join('\n');
  const execution = spawnSync(binary, [], { input, encoding: 'utf8', timeout: 60000 });
  assert.equal(execution.status, 0, execution.stderr || 'Go 校验器失败');
  const goResults = execution.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(goResults.length, cases.length);

  for (let index = 0; index < cases.length; index += 1) {
    const fixture = cases[index];
    const nodeResult = runNodeValidation(fixture.manifest);
    const goResult = goResults[index];
    assert.equal(goResult.ok, nodeResult.ok, fixture.name + ' 的 accept/reject 结论不一致');
    if (nodeResult.ok) {
      assert.equal(goResult.fingerprint, nodeResult.fingerprint, fixture.name + ' 的 permissionsFingerprint 不一致');
    } else {
      assert.equal(goResult.code, nodeResult.code, fixture.name + ' 的错误码不一致（Go=' + goResult.code + ' Node=' + nodeResult.code + '）');
    }
  }
});
