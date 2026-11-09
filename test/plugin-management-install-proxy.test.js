'use strict';

// /v0/plugins/install|uninstall 固定转发 Go：制品校验、签名、清单与状态 CAS 已切 Go。
// 这组用例锁四件事：
//   1) 成功响应原样透传（字段不经过 Node 二次映射）；
//   2) Go 的 400/404/409/503 状态码与错误体原样透传；
//   3) Go 不可用（门面缺失 / 方法缺失 / 传输失败 / 抛错）一律 503 go_core_unavailable，不回落本地安装；
//   4) install/uninstall 成功后 control.audit 仍在 Node 追加，失败不写审计。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handlePluginManagementRequest } = require('../lib/server/plugin-management-routes');

const MANAGEMENT_KEY = 'management-test-key';

function tempHome(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-plugin-install-proxy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function bodyStream(body) {
  return {
    async *[Symbol.asyncIterator]() {
      if (body === undefined) return;
      yield Buffer.from(JSON.stringify(body), 'utf8');
    }
  };
}

function createCtx({
  method = 'POST',
  pathname = '/v0/plugins/install',
  body,
  deps = {},
  headers,
  state = {}
} = {}) {
  const writes = [];
  return {
    writes,
    ctx: {
      method,
      pathname,
      req: {
        url: pathname,
        headers: headers || { authorization: 'Bearer ' + MANAGEMENT_KEY },
        ...bodyStream(body)
      },
      res: {},
      state,
      requiredManagementKey: MANAGEMENT_KEY,
      deps: {
        writeJson: (_res, status, payload) => writes.push({ status, payload }),
        ...deps
      }
    }
  };
}

function goResult(status, payload, ok = status >= 200 && status < 300) {
  return { ok, status, data: payload, body: payload, errorCode: ok ? '' : 'http_' + status };
}

const INSTALL_RESULT = {
  ok: true,
  pluginId: 'aih.test.echo',
  version: '1.0.0',
  digest: 'abc123',
  revision: 7,
  signature: { status: 'signed', keyId: 'dev-key', signedAt: '2026-01-01T00:00:00.000Z' },
  permissions: { network: ['https://api.example.com'], filesystem: { read: [], write: [] }, secrets: [], environment: [] }
};

function goHost(responses = {}) {
  const calls = [];
  const host = { calls };
  for (const name of ['installPlugin', 'uninstallPlugin']) {
    host[name] = async (...args) => {
      calls.push({ name, args });
      const response = responses[name];
      if (typeof response === 'function') return response(...args);
      if (response && response.throws) throw new Error('go core exploded');
      return response;
    };
  }
  return host;
}

function readAudit(home) {
  const file = path.join(home, 'plugins', 'audit.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('install 透传 Go 响应并写审计：file 先 resolve 成绝对路径', async (t) => {
  const home = tempHome(t);
  const host = goHost({ installPlugin: goResult(200, INSTALL_RESULT) });
  const { ctx, writes } = createCtx({
    body: { file: './relative/plugin.aih-plugin', requireSigned: true },
    deps: { goCoreSync: host, aiHomeDir: home }
  });

  assert.equal(await handlePluginManagementRequest(ctx), true);
  assert.equal(host.calls.length, 1);
  assert.deepEqual(host.calls[0].args, [{
    file: path.resolve('./relative/plugin.aih-plugin'),
    requireSigned: true
  }]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 200);
  assert.deepEqual(writes[0].payload, INSTALL_RESULT);

  const audit = readAudit(home);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].event, 'install');
  assert.equal(audit[0].pluginId, 'aih.test.echo');
  assert.equal(audit[0].digest, 'abc123');
  assert.equal(audit[0].signature, 'signed');
  assert.equal(audit[0].keyId, 'dev-key');
  assert.deepEqual(audit[0].permissions, INSTALL_RESULT.permissions);
});

test('install 的 Go 409 原样透传且不写审计', async (t) => {
  const home = tempHome(t);
  const errorBody = {
    ok: false,
    error: 'plugin_version_conflict',
    message: 'aih.test.echo@1.0.0 已安装且内容不同；请提升版本号',
    diagnostics: []
  };
  const host = goHost({ installPlugin: goResult(409, errorBody, false) });
  const { ctx, writes } = createCtx({
    body: { file: '/tmp/x.aih-plugin' },
    deps: { goCoreSync: host, aiHomeDir: home }
  });

  await handlePluginManagementRequest(ctx);

  assert.equal(writes[0].status, 409);
  assert.deepEqual(writes[0].payload, errorBody);
  assert.deepEqual(readAudit(home), []);
  assert.equal(fs.existsSync(path.join(home, 'plugins', 'accepted')), false, '不得回落本地安装');
});

test('uninstall 透传 Go 响应并写审计', async (t) => {
  const home = tempHome(t);
  const host = goHost({ uninstallPlugin: goResult(200, { ok: true, pluginId: 'aih.test.echo', version: '1.0.0', revision: 8 }) });
  const { ctx, writes } = createCtx({
    pathname: '/v0/plugins/uninstall',
    body: { pluginId: 'aih.test.echo', version: '1.0.0', expectedRevision: 7 },
    deps: { goCoreSync: host, aiHomeDir: home }
  });

  await handlePluginManagementRequest(ctx);

  assert.deepEqual(host.calls[0].args, [{ pluginId: 'aih.test.echo', version: '1.0.0', expectedRevision: 7 }]);
  assert.equal(writes[0].status, 200);
  assert.deepEqual(writes[0].payload, { ok: true, pluginId: 'aih.test.echo', version: '1.0.0', revision: 8 });
  const audit = readAudit(home);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].event, 'uninstall');
  assert.equal(audit[0].pluginId, 'aih.test.echo');
});

test('uninstall 的 Go 404 原样透传且不写审计', async (t) => {
  const home = tempHome(t);
  const errorBody = { ok: false, error: 'plugin_not_installed', message: '未安装插件 ghost', diagnostics: [] };
  const host = goHost({ uninstallPlugin: goResult(404, errorBody, false) });
  const { ctx, writes } = createCtx({
    pathname: '/v0/plugins/uninstall',
    body: { pluginId: 'ghost' },
    deps: { goCoreSync: host, aiHomeDir: home }
  });

  await handlePluginManagementRequest(ctx);

  assert.equal(writes[0].status, 404);
  assert.deepEqual(writes[0].payload, errorBody);
  assert.deepEqual(readAudit(home), []);
});

test('Go 不可用：门面缺失 / 方法缺失 / transport 失败 / 抛错都收敛成 503', async (t) => {
  const home = tempHome(t);
  const cases = [
    { name: '门面缺失', deps: { aiHomeDir: home } },
    { name: '方法缺失', deps: { aiHomeDir: home, goCoreSync: {} } },
    { name: 'transport 失败', deps: { aiHomeDir: home, goCoreSync: goHost({ installPlugin: { ok: false, status: 0, data: null, errorCode: 'network_error' } }) } },
    { name: '抛错', deps: { aiHomeDir: home, goCoreSync: goHost({ installPlugin: { throws: true } }) } }
  ];
  for (const testCase of cases) {
    const { ctx, writes } = createCtx({ body: { file: '/tmp/x' }, deps: testCase.deps });
    await handlePluginManagementRequest(ctx);
    assert.equal(writes[0].status, 503, testCase.name);
    assert.equal(writes[0].payload.ok, false, testCase.name);
    assert.equal(writes[0].payload.error, 'go_core_unavailable', testCase.name);
  }
  assert.equal(fs.existsSync(path.join(home, 'plugins', 'accepted')), false, 'Go 不可用时不得回落本地安装');
});

test('鉴权仍然只认管理密钥：未带密钥时不碰 Go', async (t) => {
  const home = tempHome(t);
  const host = goHost({ installPlugin: goResult(200, INSTALL_RESULT) });
  const { ctx, writes } = createCtx({ body: { file: '/tmp/x' }, deps: { goCoreSync: host, aiHomeDir: home }, headers: {} });

  await handlePluginManagementRequest(ctx);

  assert.equal(writes[0].status, 401);
  assert.equal(writes[0].payload.error, 'unauthorized_management');
  assert.equal(host.calls.length, 0);
});
