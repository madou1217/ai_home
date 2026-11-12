'use strict';

// /v0/plugins/trusted|trust|untrust 固定转发 Go：信任根是文件型写面，写入口已收敛到 Go。
// 这组用例锁四件事：
//   1) 成功响应原样透传（字段不经过 Node 二次映射）；
//   2) Go 的 400/404/503 状态码与错误体原样透传，不重新归类；
//   3) Go 不可用（门面缺失 / 方法缺失 / 传输失败 / 抛错）一律 503 go_core_unavailable；
//   4) trust/untrust 成功后 control.audit 仍在 Node 追加，失败不写审计。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handlePluginManagementRequest } = require('../lib/server/plugin-management-routes');

const MANAGEMENT_KEY = 'management-test-key';

function tempHome(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-plugin-trust-test-'));
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
  method = 'GET',
  pathname = '/v0/plugins/trusted',
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
        headers: headers || { authorization: `Bearer ${MANAGEMENT_KEY}` },
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

// 管理客户端的真实返回结构：ok/status/data/body/errorCode。
function goResult(status, payload, ok = status >= 200 && status < 300) {
  return {
    ok,
    status,
    data: payload,
    body: payload,
    errorCode: ok ? '' : `http_${status}`
  };
}

function goHost(responses = {}) {
  const calls = [];
  const host = { calls };
  for (const name of ['getPluginTrustedKeys', 'addPluginTrustedKey', 'removePluginTrustedKey']) {
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

test('信任根列表读 Go 并原样透传', async (t) => {
  const home = tempHome(t);
  const host = goHost({
    getPluginTrustedKeys: goResult(200, {
      ok: true,
      keys: [{ keyId: 'dev-key', fingerprint: 'abc123', algorithm: 'ed25519' }]
    })
  });
  const { ctx, writes } = createCtx({ deps: { goCoreSync: host, aiHomeDir: home } });

  assert.equal(await handlePluginManagementRequest(ctx), true);
  assert.equal(host.calls.length, 1);
  assert.deepEqual(host.calls[0], { name: 'getPluginTrustedKeys', args: [] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 200);
  assert.deepEqual(writes[0].payload, {
    ok: true,
    keys: [{ keyId: 'dev-key', fingerprint: 'abc123', algorithm: 'ed25519' }]
  });
});

test('Go 的 400 错误原样透传，不写审计', async (t) => {
  const home = tempHome(t);
  const host = goHost({
    getPluginTrustedKeys: goResult(400, {
      ok: false,
      error: 'plugin_trust_store_invalid',
      message: '信任根文件不是合法 JSON：/tmp/x/plugins/trusted-keys.json',
      diagnostics: []
    }, false)
  });
  const { ctx, writes } = createCtx({ deps: { goCoreSync: host, aiHomeDir: home } });

  await handlePluginManagementRequest(ctx);

  assert.equal(writes[0].status, 400);
  assert.deepEqual(writes[0].payload, {
    ok: false,
    error: 'plugin_trust_store_invalid',
    message: '信任根文件不是合法 JSON：/tmp/x/plugins/trusted-keys.json',
    diagnostics: []
  });
  assert.deepEqual(readAudit(home), []);
});

test('trust 成功后写审计：公钥与 keyId 转发给 Go，审计留在 Node', async (t) => {
  const home = tempHome(t);
  const host = goHost({
    addPluginTrustedKey: goResult(200, {
      ok: true,
      keyId: 'dev-key',
      file: path.join(home, 'plugins', 'trusted-keys.json'),
      fingerprint: 'fingerprint-1'
    })
  });
  const { ctx, writes } = createCtx({
    method: 'POST',
    pathname: '/v0/plugins/trust',
    body: { publicKey: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n', keyId: 'dev-key' },
    deps: { goCoreSync: host, aiHomeDir: home }
  });

  await handlePluginManagementRequest(ctx);

  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0].name, 'addPluginTrustedKey');
  assert.deepEqual(host.calls[0].args, [{
    publicKey: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n',
    keyId: 'dev-key'
  }]);
  assert.equal(writes[0].status, 200);
  assert.equal(writes[0].payload.keyId, 'dev-key');
  assert.equal(writes[0].payload.fingerprint, 'fingerprint-1');

  const audit = readAudit(home);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].event, 'trust');
  assert.equal(audit[0].keyId, 'dev-key');
  assert.equal(audit[0].fingerprint, 'fingerprint-1');
});

test('trust 的 body.file 在 Node 读成 PEM 再交给 Go', async (t) => {
  const home = tempHome(t);
  const pemFile = path.join(home, 'public.pem');
  fs.writeFileSync(pemFile, '-----BEGIN PUBLIC KEY-----\nFILE\n-----END PUBLIC KEY-----\n');
  const host = goHost({
    addPluginTrustedKey: goResult(200, { ok: true, keyId: 'file-key', file: 'x', fingerprint: 'f' })
  });
  const { ctx } = createCtx({
    method: 'POST',
    pathname: '/v0/plugins/trust',
    body: { file: pemFile, keyId: 'file-key' },
    deps: { goCoreSync: host, aiHomeDir: home }
  });

  await handlePluginManagementRequest(ctx);

  assert.equal(host.calls[0].name, 'addPluginTrustedKey');
  assert.equal(host.calls[0].args[0].publicKey, '-----BEGIN PUBLIC KEY-----\nFILE\n-----END PUBLIC KEY-----\n');
  assert.equal(host.calls[0].args[0].keyId, 'file-key');
});

test('trust 的 Go 400 透传且不写审计', async (t) => {
  const home = tempHome(t);
  const host = goHost({
    addPluginTrustedKey: goResult(400, {
      ok: false,
      error: 'plugin_signature_key_invalid',
      message: '公钥不是合法的 Ed25519 PEM',
      diagnostics: []
    }, false)
  });
  const { ctx, writes } = createCtx({
    method: 'POST',
    pathname: '/v0/plugins/trust',
    body: { publicKey: 'nope' },
    deps: { goCoreSync: host, aiHomeDir: home }
  });

  await handlePluginManagementRequest(ctx);

  assert.equal(writes[0].status, 400);
  assert.equal(writes[0].payload.error, 'plugin_signature_key_invalid');
  assert.deepEqual(readAudit(home), []);
});

test('untrust 成功后写审计：keyId 与 removed 来自 Go 响应', async (t) => {
  const home = tempHome(t);
  const host = goHost({
    removePluginTrustedKey: goResult(200, {
      ok: true,
      keyId: 'dev-key',
      removed: true,
      file: path.join(home, 'plugins', 'trusted-keys.json')
    })
  });
  const { ctx, writes } = createCtx({
    method: 'POST',
    pathname: '/v0/plugins/untrust',
    body: { keyId: 'dev-key' },
    deps: { goCoreSync: host, aiHomeDir: home }
  });

  await handlePluginManagementRequest(ctx);

  assert.deepEqual(host.calls[0], { name: 'removePluginTrustedKey', args: ['dev-key'] });
  assert.equal(writes[0].status, 200);
  assert.equal(writes[0].payload.removed, true);

  const audit = readAudit(home);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].event, 'untrust');
  assert.equal(audit[0].keyId, 'dev-key');
  assert.equal(audit[0].removed, true);
});

test('Go 404 原样透传（不套本地 404 语义）', async (t) => {
  const home = tempHome(t);
  const host = goHost({
    removePluginTrustedKey: goResult(404, { ok: false, error: 'not_found', message: '路径不存在' }, false)
  });
  const { ctx, writes } = createCtx({
    method: 'POST',
    pathname: '/v0/plugins/untrust',
    body: { keyId: 'ghost' },
    deps: { goCoreSync: host, aiHomeDir: home }
  });

  await handlePluginManagementRequest(ctx);

  assert.equal(writes[0].status, 404);
  assert.deepEqual(writes[0].payload, { ok: false, error: 'not_found', message: '路径不存在' });
  assert.deepEqual(readAudit(home), []);
});

test('Go 不可用：goCoreSync 缺失 / 方法缺失 / transport 失败 / 抛错都收敛成 503', async (t) => {
  const home = tempHome(t);
  const cases = [
    { name: '门面缺失', deps: { aiHomeDir: home } },
    { name: '方法缺失', deps: { aiHomeDir: home, goCoreSync: {} } },
    { name: 'transport 失败', deps: { aiHomeDir: home, goCoreSync: goHost({ getPluginTrustedKeys: { ok: false, status: 0, data: null, errorCode: 'network_error' } }) } },
    { name: '抛错', deps: { aiHomeDir: home, goCoreSync: goHost({ getPluginTrustedKeys: { throws: true } }) } }
  ];
  for (const testCase of cases) {
    const { ctx, writes } = createCtx({ deps: testCase.deps });
    await handlePluginManagementRequest(ctx);
    assert.equal(writes[0].status, 503, testCase.name);
    assert.equal(writes[0].payload.ok, false, testCase.name);
    assert.equal(writes[0].payload.error, 'go_core_unavailable', testCase.name);
  }
});

test('鉴权仍然只认管理密钥：未带密钥时不碰 Go', async (t) => {
  const home = tempHome(t);
  const host = goHost({ getPluginTrustedKeys: goResult(200, { ok: true, keys: [] }) });
  const { ctx, writes } = createCtx({ deps: { goCoreSync: host, aiHomeDir: home }, headers: {} });

  await handlePluginManagementRequest(ctx);

  assert.equal(writes[0].status, 401);
  assert.equal(writes[0].payload.error, 'unauthorized_management');
  assert.equal(host.calls.length, 0);
});
