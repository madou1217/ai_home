'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { upsertAccountRef } = require('../lib/server/account-ref-store');
const {
  readAccountEgressBinding,
  writeAccountEgressBinding
} = require('../lib/account/zcode-egress-binding-store');
const {
  handleZcodeEgressRequest,
  matchEgressRoute,
  parseEgressRoute,
  parseEgressRotateRoute
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

test('egress 路由只匹配 GET/POST，并安全解析账号路径', () => {
  const pathname = '/v0/webui/accounts/zcode/acct_91aa805bdd051b40fa47/egress';
  assert.equal(matchEgressRoute('GET', pathname), true);
  assert.equal(matchEgressRoute('POST', pathname), true);
  assert.equal(matchEgressRoute('DELETE', pathname), false);
  assert.deepEqual(parseEgressRoute(pathname), {
    provider: 'zcode',
    accountRef: 'acct_91aa805bdd051b40fa47'
  });
  assert.equal(parseEgressRoute('/v0/webui/accounts/zcode/%E0%A4%A/egress'), null);
  const rotatePath = `${pathname}/rotate`;
  assert.equal(matchEgressRoute('POST', rotatePath), true);
  assert.equal(matchEgressRoute('GET', rotatePath), false);
  assert.deepEqual(parseEgressRotateRoute(rotatePath), {
    provider: 'zcode',
    accountRef: 'acct_91aa805bdd051b40fa47'
  });
});

test('egress POST 写入后 GET 返回同一账号绑定', async (t) => {
  const fixture = createFixture(t);
  const post = createContext(
    fixture,
    'POST',
    Buffer.from(JSON.stringify({ mode: 'url', proxyUrl: '127.0.0.1:10801' }))
  );
  post.deps = {
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
  assert.equal(post.res.payload.apply.status, 'pending_launch');

  const get = createContext(fixture, 'GET', null);
  await handleZcodeEgressRequest(get);
  assert.equal(get.res.statusCode, 200);
  assert.equal(get.res.payload.binding.proxyUrl, '127.0.0.1:10801');
  assert.ok(Object.prototype.hasOwnProperty.call(get.res.payload, 'runtime'));
});

test('egress GET 返回当前节点、分组、sidecar 与健康运行态', async (t) => {
  const fixture = createFixture(t);
  writeAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef, {
    mode: 'group',
    groupId: 'group-fast'
  });
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
          running: true,
          dataPlaneReady: true,
          proxyServer: '127.0.0.1:23100',
          selectedNodeId: 'node-a',
          groupId: 'group-fast',
          zcodePid: 8123,
          canRotate: true,
          sidecar: { engine: 'sing-box', running: true, dataPlaneReady: true },
          health: { monitoring: true, consecutiveFailures: 0 }
        }
      };
    }
  };

  await handleZcodeEgressRequest(ctx);

  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.res.payload.runtime.selectedNodeId, 'node-a');
  assert.equal(ctx.res.payload.runtime.groupId, 'group-fast');
  assert.equal(ctx.res.payload.runtime.canRotate, true);
  assert.equal(ctx.res.payload.runtime.health.monitoring, true);
});

test('egress rotate 路由只调用运行态轮换服务并返回更新后的状态', async (t) => {
  const fixture = createFixture(t);
  writeAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef, {
    mode: 'group',
    groupId: 'group-fast'
  });
  const calls = [];
  const ctx = createContext(
    fixture,
    'POST',
    null,
    `/v0/webui/accounts/zcode/${fixture.accountRef}/egress/rotate`
  );
  ctx.deps = {
    async rotateStoredAccountEgress(input) {
      calls.push(input.accountRef);
      return {
        ok: true,
        applied: true,
        rotated: true,
        status: 'selected',
        previousNodeId: 'node-a',
        selectedNodeId: 'node-b',
        groupId: 'group-fast'
      };
    },
    getAccountEgressRuntimeStatus() {
      return {
        ok: true,
        runtime: {
          running: true,
          dataPlaneReady: true,
          selectedNodeId: 'node-b',
          groupId: 'group-fast',
          canRotate: true,
          sidecar: { engine: 'sing-box', running: true, dataPlaneReady: true },
          health: { monitoring: true }
        }
      };
    }
  };

  await handleZcodeEgressRequest(ctx);

  assert.equal(ctx.res.statusCode, 200);
  assert.deepEqual(calls, [fixture.accountRef]);
  assert.equal(ctx.res.payload.rotated, true);
  assert.equal(ctx.res.payload.previousNodeId, 'node-a');
  assert.equal(ctx.res.payload.runtime.selectedNodeId, 'node-b');
});

test('egress POST 接受 system、tun、url、node、group 五种模式并实时应用', async (t) => {
  const fixture = createFixture(t);
  const cases = [
    [{ mode: 'system' }, { mode: 'system', proxyUrl: '', nodeId: '', groupId: '' }],
    [{ mode: 'tun' }, { mode: 'tun', proxyUrl: '', nodeId: '', groupId: '' }],
    [{ mode: 'url', proxyUrl: 'socks4a://proxy.example:1080' }, { mode: 'url', proxyUrl: 'socks4a://proxy.example:1080' }],
    [{ mode: 'node', nodeId: 'node-a' }, { mode: 'node', nodeId: 'node-a' }],
    [{ mode: 'group', groupId: 'group-fast' }, { mode: 'group', groupId: 'group-fast' }]
  ];

  for (const [payload, expected] of cases) {
    const calls = [];
    const ctx = createContext(fixture, 'POST', Buffer.from(JSON.stringify(payload)));
    ctx.deps = {
      applyStoredAccountEgress(input) {
        calls.push(input);
        return Promise.resolve({ ok: true, applied: true, status: 'selected' });
      }
    };

    await handleZcodeEgressRequest(ctx);

    assert.equal(ctx.res.statusCode, 200, payload.mode);
    assert.equal(ctx.res.payload.binding.mode, expected.mode, payload.mode);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(ctx.res.payload.binding[key], value, `${payload.mode}:${key}`);
    }
    assert.deepEqual(ctx.res.payload.apply, { ok: true, applied: true, status: 'selected' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].accountRef, fixture.accountRef);
  }
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

test('egress POST 实时应用失败时恢复旧绑定并重新应用旧 endpoint', async (t) => {
  const fixture = createFixture(t);
  writeAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef, {
    mode: 'tun'
  });
  const calls = [];
  const ctx = createContext(
    fixture,
    'POST',
    Buffer.from(JSON.stringify({ mode: 'node', nodeId: 'node-bad' }))
  );
  ctx.deps = {
    applyStoredAccountEgress(input) {
      calls.push(input);
      return Promise.resolve(calls.length === 1
        ? { ok: false, applied: false, error: 'proxy_unreachable', reason: 'curl_exit_28' }
        : { ok: true, applied: true, status: 'selected', source: 'tun' });
    }
  };

  await handleZcodeEgressRequest(ctx);

  assert.equal(ctx.res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].preserveAccountEndpointOnFailure, true);
  assert.equal(calls[1].preserveAccountEndpointOnFailure, true);
  assert.equal(ctx.res.payload.binding.mode, 'tun');
  assert.equal(ctx.res.payload.apply.error, 'proxy_unreachable');
  assert.equal(ctx.res.payload.apply.rolledBack, true);
  assert.equal(readAccountEgressBinding(fs, fixture.aiHomeDir, fixture.accountRef).mode, 'tun');
});

test('egress POST 拒绝旧 pool 模式', async (t) => {
  const fixture = createFixture(t);
  const ctx = createContext(
    fixture,
    'POST',
    Buffer.from(JSON.stringify({ mode: 'pool', nodeId: 'node-a' }))
  );

  await handleZcodeEgressRequest(ctx);

  assert.equal(ctx.res.statusCode, 400);
  assert.equal(ctx.res.payload.error, 'invalid_egress_mode');
});

test('egress POST 拒绝缺少目标的 node/group', async (t) => {
  const fixture = createFixture(t);
  for (const payload of [{ mode: 'node' }, { mode: 'group' }]) {
    const ctx = createContext(fixture, 'POST', Buffer.from(JSON.stringify(payload)));
    await handleZcodeEgressRequest(ctx);
    assert.equal(ctx.res.statusCode, 400, payload.mode);
    assert.equal(ctx.res.payload.error, 'invalid_egress_binding');
  }
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
