'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listProviderIds } = require('../lib/provider-catalog');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const {
  readAccountEgressBinding,
  writeAccountEgressBinding
} = require('../lib/account/zcode-egress-binding-store');
const { writeJsonValue } = require('../lib/server/app-state-store');
const { buildEgressBindingKey } = require('../lib/account/zcode-egress-binding-store');
const {
  handleZcodeEgressRequest,
  matchEgressRoute,
  parseEgressRoute
} = require('../lib/server/webui-zcode-egress-routes');

function createResponse() {
  return {
    statusCode: 0,
    payload: null
  };
}

function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.payload = payload;
}

function createFixture(t, provider = 'zcode') {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-route-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider,
    cliAccountId: '1',
    identitySeed: `oauth:${provider}:egress-route@example.com`
  });
  return { accountRef, aiHomeDir, provider };
}

function createContext(fixture, method, payload, pathname) {
  return {
    pathname: pathname || `/v0/webui/accounts/${fixture.provider}/${fixture.accountRef}/egress`,
    req: { method },
    res: createResponse(),
    fs,
    aiHomeDir: fixture.aiHomeDir,
    readRequestBody: async () => payload,
    writeJson
  };
}

test('egress 路由只匹配 GET/POST，并安全解析账号路径；轮换接口已下线', () => {
  const pathname = '/v0/webui/accounts/zcode/acct_91aa805bdd051b40fa47/egress';
  assert.equal(matchEgressRoute('GET', pathname), true);
  assert.equal(matchEgressRoute('POST', pathname), true);
  assert.equal(matchEgressRoute('DELETE', pathname), false);
  assert.deepEqual(parseEgressRoute(pathname), {
    provider: 'zcode',
    accountRef: 'acct_91aa805bdd051b40fa47'
  });
  assert.equal(parseEgressRoute('/v0/webui/accounts/zcode/%E0%A4%A/egress'), null);
  assert.equal(matchEgressRoute('POST', `${pathname}/rotate`), false);
});

test('egress POST 写入后 GET 返回同一账号绑定', async (t) => {
  const fixture = createFixture(t);
  const probes = [];
  const post = createContext(
    fixture,
    'POST',
    Buffer.from(JSON.stringify({ mode: 'url', proxyUrl: '127.0.0.1:10801' }))
  );
  post.processObj = { platform: 'darwin', env: {} };
  post.deps = {
    probeProxyServer: async (proxyServer) => {
      probes.push(proxyServer);
      return { ok: true };
    },
    createWebUiAccountAppLauncher() {
      return {
        launchAccountApp(input) {
          assert.equal(input.deferDesktopSpawn, true);
          return { ok: true, status: 'launch_ready' };
        }
      };
    }
  };
  await handleZcodeEgressRequest(post);
  assert.equal(post.res.statusCode, 200);
  assert.equal(post.res.payload.binding.proxyUrl, '127.0.0.1:10801');
  assert.equal(post.res.payload.apply.status, 'applied');
  assert.equal(post.res.payload.apply.proxyServer, 'http://127.0.0.1:10801');
  assert.deepEqual(probes, ['http://127.0.0.1:10801']);

  const get = createContext(fixture, 'GET', null);
  get.processObj = { platform: 'darwin', env: {} };
  await handleZcodeEgressRequest(get);
  assert.equal(get.res.statusCode, 200);
  assert.equal(get.res.payload.binding.proxyUrl, '127.0.0.1:10801');
  assert.equal(get.res.payload.runtime.resolved.proxyServer, 'http://127.0.0.1:10801');
});

test('egress 路由允许任意真实 provider 账号按自身路径绑定', async (t) => {
  for (const provider of listProviderIds()) {
    const fixture = createFixture(t, provider);
    const ctx = createContext(
      fixture,
      'POST',
      Buffer.from(JSON.stringify({ mode: 'url', proxyUrl: '127.0.0.1:10801' }))
    );
    const calls = [];
    ctx.deps = {
      async applyStoredAccountEgress(input) {
        calls.push(input);
        return {
          ok: true,
          applied: true,
          status: 'started',
          proxyServer: '127.0.0.1:23104'
        };
      },
      getAccountEgressRuntimeStatus() {
        return {
          ok: true,
          runtime: {
            running: true,
            dataPlaneReady: true,
            proxyServer: '127.0.0.1:23104',
            health: { monitoring: false }
          }
        };
      },
      createWebUiAccountAppLauncher() {
        return { launchAccountApp() {} };
      }
    };

    await handleZcodeEgressRequest(ctx);

    assert.equal(ctx.res.statusCode, 200, provider);
    assert.equal(ctx.res.payload.binding.proxyUrl, '127.0.0.1:10801', provider);
    assert.equal(calls.length, 1, provider);
    assert.equal(calls[0].provider, provider);
    assert.equal(calls[0].accountRef, fixture.accountRef);
  }
});

test('egress GET 返回绑定实际解析到的出口与 Desktop 运行态', async (t) => {
  const fixture = createFixture(t);
  writeAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef, { mode: 'system' });
  const ctx = createContext(fixture, 'GET', null);
  const launcher = { launchAccountApp() {} };
  ctx.deps = {
    createWebUiAccountAppLauncher(inputCtx, provider, accountRef, action) {
      assert.equal(inputCtx, ctx);
      assert.equal(provider, 'zcode');
      assert.equal(accountRef, fixture.accountRef);
      assert.equal(action, 'inspect');
      return launcher;
    },
    getAccountEgressRuntimeStatus(input) {
      assert.equal(input.accountRef, fixture.accountRef);
      assert.equal(input.launcher, launcher);
      return {
        ok: true,
        runtime: {
          resolved: { ok: true, source: 'system', proxyServer: 'http://127.0.0.1:6152', direct: false },
          desktopRunning: true,
          desktopPid: 8123
        }
      };
    }
  };

  await handleZcodeEgressRequest(ctx);

  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.res.payload.binding.mode, 'system');
  assert.equal(ctx.res.payload.runtime.resolved.proxyServer, 'http://127.0.0.1:6152');
  assert.equal(ctx.res.payload.runtime.desktopRunning, true);
});

test('egress POST 接受 system、tun、url 三种模式并立即应用', async (t) => {
  const fixture = createFixture(t);
  const cases = [
    [{ mode: 'system' }, { mode: 'system', proxyUrl: '' }],
    [{ mode: 'tun' }, { mode: 'tun', proxyUrl: '' }],
    [{ mode: 'url', proxyUrl: 'https://proxy.example:8443' }, { mode: 'url', proxyUrl: 'https://proxy.example:8443' }]
  ];

  for (const [payload, expected] of cases) {
    const calls = [];
    const ctx = createContext(fixture, 'POST', Buffer.from(JSON.stringify(payload)));
    ctx.deps = {
      applyStoredAccountEgress(input) {
        calls.push(input);
        return Promise.resolve({ ok: true, applied: true, status: 'applied' });
      }
    };

    await handleZcodeEgressRequest(ctx);

    assert.equal(ctx.res.statusCode, 200, payload.mode);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(ctx.res.payload.binding[key], value, `${payload.mode}:${key}`);
    }
    assert.deepEqual(ctx.res.payload.apply, { ok: true, applied: true, status: 'applied' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].accountRef, fixture.accountRef);
  }
});

test('egress POST 拒绝已下线的 node/group/pool 模式与 socks 代理地址', async (t) => {
  const fixture = createFixture(t);
  const cases = [
    [{ mode: 'node', nodeId: 'node-a' }, 'invalid_egress_mode'],
    [{ mode: 'group', groupId: 'group-fast' }, 'invalid_egress_mode'],
    [{ mode: 'pool', nodeId: 'node-a' }, 'invalid_egress_mode'],
    [{ mode: 'url', proxyUrl: 'socks5://127.0.0.1:6153' }, 'proxy_scheme_unsupported'],
    [{ mode: 'url', proxyUrl: 'http://user:pass@proxy.example:8080' }, 'invalid_proxy_url']
  ];
  for (const [payload, error] of cases) {
    const ctx = createContext(fixture, 'POST', Buffer.from(JSON.stringify(payload)));
    ctx.deps = {
      applyStoredAccountEgress() {
        throw new Error('must not apply a rejected binding');
      }
    };
    await handleZcodeEgressRequest(ctx);
    assert.equal(ctx.res.statusCode, 400, JSON.stringify(payload));
    assert.equal(ctx.res.payload.error, error, JSON.stringify(payload));
  }
  assert.equal(readAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef), null);
});

test('egress POST 把账号级 Desktop launcher 注入首次运行态接管流程', async (t) => {
  const fixture = createFixture(t);
  const launcher = { launchAccountApp() {} };
  const ctx = createContext(
    fixture,
    'POST',
    Buffer.from(JSON.stringify({ mode: 'system' }))
  );
  ctx.deps = {
    createWebUiAccountAppLauncher(inputCtx, provider, accountRef, action) {
      assert.equal(inputCtx, ctx);
      assert.equal(provider, 'zcode');
      assert.equal(accountRef, fixture.accountRef);
      assert.equal(action, 'open');
      return launcher;
    },
    applyStoredAccountEgress(input) {
      assert.equal(input.launcher, launcher);
      return Promise.resolve({ ok: true, applied: true, status: 'restarted' });
    }
  };

  await handleZcodeEgressRequest(ctx);

  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.res.payload.apply.status, 'restarted');
});

test('egress POST 应用失败时恢复旧绑定并重新应用', async (t) => {
  const fixture = createFixture(t);
  writeAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef, { mode: 'tun' });
  const calls = [];
  const ctx = createContext(
    fixture,
    'POST',
    Buffer.from(JSON.stringify({ mode: 'url', proxyUrl: 'http://127.0.0.1:1' }))
  );
  ctx.deps = {
    applyStoredAccountEgress(input) {
      calls.push(input);
      return Promise.resolve(calls.length === 1
        ? { ok: false, applied: false, error: 'proxy_unreachable', reason: 'curl_exit_7' }
        : { ok: true, applied: true, status: 'applied', source: 'tun' });
    }
  };

  await handleZcodeEgressRequest(ctx);

  assert.equal(ctx.res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(ctx.res.payload.binding.mode, 'tun');
  assert.equal(ctx.res.payload.apply.error, 'proxy_unreachable');
  assert.equal(ctx.res.payload.apply.rolledBack, true);
  assert.equal(readAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef).mode, 'tun');
});

test('egress POST 应用失败且旧绑定是已下线模式时保留新绑定，不写回旧记录', async (t) => {
  const fixture = createFixture(t);
  writeJsonValue(fs, fixture.aiHomeDir, buildEgressBindingKey(fixture.accountRef), {
    mode: 'group',
    groupId: 'subscription:sub_deleted'
  });
  const calls = [];
  const ctx = createContext(
    fixture,
    'POST',
    Buffer.from(JSON.stringify({ mode: 'system' }))
  );
  ctx.deps = {
    applyStoredAccountEgress(input) {
      calls.push(input);
      return Promise.resolve({ ok: false, applied: false, error: 'system_proxy_unavailable' });
    }
  };

  await handleZcodeEgressRequest(ctx);

  assert.equal(ctx.res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(ctx.res.payload.apply.error, 'system_proxy_unavailable');
  assert.equal(readAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef).mode, 'system');
});

test('egress POST 模式对应字段为空时显式解绑', async (t) => {
  const fixture = createFixture(t);
  writeAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef, {
    mode: 'url',
    proxyUrl: '127.0.0.1:10801'
  });
  const ctx = createContext(
    fixture,
    'POST',
    Buffer.from(JSON.stringify({ mode: 'url', proxyUrl: '' }))
  );
  ctx.deps = {
    applyStoredAccountEgress() {
      return Promise.resolve({
        ok: true,
        applied: true,
        status: 'applied',
        source: 'direct'
      });
    }
  };

  await handleZcodeEgressRequest(ctx);

  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.res.payload.binding, null);
  assert.equal(readAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef), null);
});

test('egress POST 的坏 JSON 返回 400，不能被解释成解绑', async (t) => {
  const fixture = createFixture(t);
  writeAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef, {
    mode: 'url',
    proxyUrl: '127.0.0.1:10801'
  });
  const ctx = createContext(fixture, 'POST', Buffer.from('{'));

  await handleZcodeEgressRequest(ctx);

  assert.equal(ctx.res.statusCode, 400);
  assert.equal(ctx.res.payload.error, 'invalid_json_body');
  assert.equal(
    readAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef).proxyUrl,
    '127.0.0.1:10801'
  );
});

test('egress GET/POST 读取绑定异常时返回稳定 500，不能伪装成未绑定', async (t) => {
  const fixture = createFixture(t);
  const methods = ['GET', 'POST'];

  for (const method of methods) {
    const ctx = createContext(
      fixture,
      method,
      method === 'POST'
        ? Buffer.from(JSON.stringify({ mode: 'url', proxyUrl: '127.0.0.1:10801' }))
        : null
    );
    ctx.deps = {
      readAccountEgressBinding() {
        throw new Error('sensitive database path');
      }
    };

    await handleZcodeEgressRequest(ctx);

    assert.equal(ctx.res.statusCode, 500, method);
    assert.deepEqual(ctx.res.payload, {
      ok: false,
      error: 'egress_binding_read_failed'
    });
  }
});

test('egress POST 写入异常时返回稳定 500 且不暴露底层错误', async (t) => {
  const fixture = createFixture(t);
  const ctx = createContext(
    fixture,
    'POST',
    Buffer.from(JSON.stringify({ mode: 'url', proxyUrl: '127.0.0.1:10801' }))
  );
  ctx.deps = {
    writeAccountEgressBinding() {
      throw new Error('/private/path/app-state.db permission denied');
    }
  };

  await handleZcodeEgressRequest(ctx);

  assert.equal(ctx.res.statusCode, 500);
  assert.deepEqual(ctx.res.payload, {
    ok: false,
    error: 'egress_binding_write_failed'
  });
});

test('egress 路由拒绝把非 zcode 账号绑定到 zcode 路径', async (t) => {
  const fixture = createFixture(t, 'codex');
  const pathname = `/v0/webui/accounts/zcode/${fixture.accountRef}/egress`;
  const ctx = createContext(
    fixture,
    'POST',
    Buffer.from(JSON.stringify({ mode: 'url', proxyUrl: '127.0.0.1:10801' })),
    pathname
  );

  await handleZcodeEgressRequest(ctx);

  assert.equal(ctx.res.statusCode, 409);
  assert.equal(ctx.res.payload.error, 'account_provider_mismatch');
  assert.equal(readAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef), null);
});
