'use strict';

// /v0/plugins 的清单固定读 Go：Node 不再构建本地清单，Go 不可用就是 503。
// 这组用例锁三件事：
//   1) Go 返回的字段被映射成既有响应契约（revision / installed / instances / runtime）；
//   2) 未安装的插件原样透传 + consistency 报告，不在 Node 侧做本地过滤；
//   3) 没有开关或回退——goCoreSync 缺失、方法缺失、Go 报错都必须 503。

const test = require('node:test');
const assert = require('node:assert/strict');

const { handlePluginManagementRequest } = require('../lib/server/plugin-management-routes');

const MANAGEMENT_KEY = 'management-test-key';

function createCtx({ method = 'GET', pathname = '/v0/plugins', deps = {}, state = null, headers } = {}) {
  const writes = [];
  return {
    ctx: {
      method,
      pathname,
      // 路径里不带查询串；查询串只在 req.url 上（与真实网关一致）。
      req: { url: pathname, headers: headers || { authorization: `Bearer ${MANAGEMENT_KEY}` } },
      res: {},
      state,
      requiredManagementKey: MANAGEMENT_KEY,
      deps: {
        writeJson: (_res, status, payload) => writes.push({ status, payload }),
        ...deps
      }
    },
    writes
  };
}

// Go GET /v1/management/plugins 的真实响应形状（见 internal/transport/http/pluginapi/inventory.go）。
function goInventoryPayload(overrides = {}) {
  return {
    ok: true,
    readOnly: true,
    source: 'node-app-state',
    revision: 7,
    installed: [
      {
        pluginId: 'echo',
        version: '1.0.0',
        digest: 'sha256:abc',
        installedAt: 1_700_000_000_000,
        signature: { status: 'signed', keyId: 'k1' },
        permissions: { network: ['127.0.0.1'] },
        contributes: ['echo.reply', 'echo.ping']
      },
      {
        pluginId: 'legacy',
        version: '0.2.0',
        digest: 'sha256:def',
        installedAt: 1_700_000_000_001,
        signature: { status: 'unsigned' },
        permissions: null,
        contributes: []
      }
    ],
    instances: [
      {
        instanceId: 'echo',
        pluginId: 'echo',
        version: '1.0.0',
        enabled: true,
        configurationKeys: ['token'],
        permissionsAcceptedAt: 1_700_000_000_500,
        updatedAt: 1_700_000_000_600
      },
      {
        instanceId: 'ghost',
        pluginId: 'ghost',
        version: '9.9.9',
        enabled: false,
        configurationKeys: [],
        permissionsAcceptedAt: null,
        updatedAt: 1_700_000_000_700
      }
    ],
    runtime: {
      activeGeneration: 9,
      generations: [8, 9],
      retiringGenerations: [8],
      contributions: [{
        id: 'echo.reply',
        capability: 'gateway.request',
        order: 0,
        failurePolicy: 'deny',
        instanceId: 'echo',
        generation: 9
      }],
      instances: [
        { instanceId: 'echo', status: 'projected', generations: [9], contributions: 1 },
        { instanceId: 'ghost', status: 'absent', generations: [], contributions: 0 }
      ]
    },
    consistency: {
      ok: false,
      issues: [{
        code: 'plugin_instance_artifact_missing',
        pluginId: 'ghost',
        instanceId: 'ghost',
        detail: '实例引用的插件版本未安装'
      }]
    },
    ...overrides
  };
}

function goHost(payload, options = {}) {
  const calls = [];
  return {
    calls,
    getPluginInventory: async (...args) => {
      calls.push(args);
      if (options.throws) throw new Error('go core exploded');
      return payload;
    }
  };
}

test('清单读 Go 并映射成既有响应契约', async () => {
  const host = goHost({ ok: true, status: 200, data: goInventoryPayload(), errorCode: '' });
  // state 为 null 且 deps 里没有 aiHomeDir：如果这里还会去建 Node 插件系统，
  // 读取 app-state.db 会失败，用例会变成 400/500 而不是 200。
  const { ctx, writes } = createCtx({ deps: { goCoreSync: host } });

  assert.equal(await handlePluginManagementRequest(ctx), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 200);
  const body = writes[0].payload;

  assert.equal(host.calls.length, 1, 'Go 清单只能调用一次');
  assert.deepEqual(host.calls[0], [], '清单接口不带参数');

  assert.equal(body.ok, true);
  assert.equal(body.readOnly, true);
  assert.equal(body.source, 'node-app-state');
  assert.equal(body.revision, 7);

  // 已安装制品：字段名与旧契约完全一致，签名/权限/贡献项一个不少。
  assert.deepEqual(body.installed[0], {
    pluginId: 'echo',
    version: '1.0.0',
    digest: 'sha256:abc',
    installedAt: 1_700_000_000_000,
    signature: { status: 'signed', keyId: 'k1' },
    permissions: { network: ['127.0.0.1'] },
    contributes: ['echo.reply', 'echo.ping']
  });
  assert.deepEqual(body.installed[1].signature, { status: 'unsigned' });
  assert.equal(body.installed[1].permissions, null);
  assert.deepEqual(body.installed[1].contributes, []);

  // 实例：配置只回显键名，未确认授权是 null 而不是 0。
  assert.deepEqual(body.instances[0], {
    instanceId: 'echo',
    pluginId: 'echo',
    version: '1.0.0',
    enabled: true,
    configurationKeys: ['token'],
    permissionsAcceptedAt: 1_700_000_000_500,
    updatedAt: 1_700_000_000_600
  });
  assert.equal(body.instances[1].permissionsAcceptedAt, null);
  assert.equal(body.instances[1].enabled, false);

  // 运行态：旧契约 contributions 是 id 数组，Go 的对象数组在这里收敛成 id。
  assert.equal(body.runtime.activeGeneration, 9);
  assert.deepEqual(body.runtime.generations, [8, 9]);
  assert.deepEqual(body.runtime.retiringGenerations, [8]);
  assert.deepEqual(body.runtime.contributions, ['echo.reply']);
  assert.deepEqual(body.runtime.instances, [
    { instanceId: 'echo', status: 'projected', generations: [9], contributions: 1 },
    { instanceId: 'ghost', status: 'absent', generations: [], contributions: 0 }
  ]);

  // 一致性诊断是 Go 清单的核心增量：有缺口就照实给出，不在这里“修”。
  assert.equal(body.consistency.ok, false);
  assert.equal(body.consistency.issues[0].code, 'plugin_instance_artifact_missing');
  assert.equal(body.consistency.issues[0].instanceId, 'ghost');
});

test('未知插件原样透传：Node 不做本地过滤，缺口由 consistency 报告', async () => {
  const payload = goInventoryPayload({
    revision: 3,
    installed: [],
    instances: [{
      instanceId: 'ghost',
      pluginId: 'ghost',
      version: '9.9.9',
      enabled: true,
      configurationKeys: [],
      permissionsAcceptedAt: null,
      updatedAt: 1_700_000_000_700
    }],
    runtime: { activeGeneration: 0, generations: [], retiringGenerations: [], contributions: [], instances: [] },
    consistency: {
      ok: false,
      issues: [{
        code: 'plugin_instance_artifact_missing',
        pluginId: 'ghost',
        instanceId: 'ghost',
        detail: '实例引用的插件版本未安装'
      }]
    }
  });
  const { ctx, writes } = createCtx({ deps: { goCoreSync: goHost({ ok: true, status: 200, data: payload }) } });

  await handlePluginManagementRequest(ctx);

  assert.equal(writes[0].status, 200);
  assert.deepEqual(writes[0].payload.installed, []);
  assert.equal(writes[0].payload.instances.length, 1, '未安装的实例仍要在列表里可见');
  assert.equal(writes[0].payload.instances[0].instanceId, 'ghost');
  assert.deepEqual(writes[0].payload.consistency.issues.map((item) => item.code), ['plugin_instance_artifact_missing']);
});

test('Go 不可用：goCoreSync 缺失 → 503 go_core_unavailable', async () => {
  const { ctx, writes } = createCtx();

  await handlePluginManagementRequest(ctx);

  assert.equal(writes[0].status, 503);
  assert.equal(writes[0].payload.ok, false);
  assert.equal(writes[0].payload.error, 'go_core_unavailable');
});

test('Go 不可用：门面缺 getPluginInventory → 503（不回退本地清单）', async () => {
  const { ctx, writes } = createCtx({ deps: { goCoreSync: { pushPluginProjection: async () => ({ ok: true }) } } });

  await handlePluginManagementRequest(ctx);

  assert.equal(writes[0].status, 503);
  assert.equal(writes[0].payload.error, 'go_core_unavailable');
});

test('Go 不可用：客户端返回未就绪 → 503，并保留 Go 的错误码', async () => {
  const unreachable = createCtx({ deps: { goCoreSync: goHost({ ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' }) } });
  await handlePluginManagementRequest(unreachable.ctx);
  assert.equal(unreachable.writes[0].status, 503);
  assert.equal(unreachable.writes[0].payload.error, 'go_core_unavailable');

  // 控制面文档损坏是 Go 的领域错误。管理客户端对字符串 error 只会给 http_503，
  // 领域码要从原始 body 取出来，否则排障时只能看到「上游 503」。
  const invalid = createCtx({
    deps: {
      goCoreSync: goHost({
        ok: false,
        status: 503,
        data: null,
        body: { ok: false, error: 'plugin_state_invalid', message: '插件控制状态格式无效' },
        errorCode: 'http_503'
      })
    }
  });
  await handlePluginManagementRequest(invalid.ctx);
  assert.equal(invalid.writes[0].status, 503);
  assert.equal(invalid.writes[0].payload.error, 'plugin_state_invalid');
});

test('Go 不可用：客户端抛错也收敛成 503，不把异常漏给调用方', async () => {
  const { ctx, writes } = createCtx({ deps: { goCoreSync: goHost(null, { throws: true }) } });

  const handled = await handlePluginManagementRequest(ctx);

  assert.equal(handled, true);
  assert.equal(writes[0].status, 503);
  assert.equal(writes[0].payload.error, 'go_core_unavailable');
});

test('鉴权仍然只认管理密钥：未带密钥时不碰 Go', async () => {
  const host = goHost({ ok: true, status: 200, data: goInventoryPayload() });
  const { ctx, writes } = createCtx({ deps: { goCoreSync: host }, headers: {} });

  await handlePluginManagementRequest(ctx);

  assert.equal(writes[0].status, 401);
  assert.equal(writes[0].payload.error, 'unauthorized_management');
  assert.equal(host.calls.length, 0);
});

test('其它插件路径不受影响：doctor 仍由 Node 处理', async () => {
  const { ctx, writes } = createCtx({ pathname: '/v0/plugins/doctor' });

  await handlePluginManagementRequest(ctx);

  // doctor 还没迁：它的 runtime 是 Node 宿主的状态机（generationsOnHost 这类字段 Go 没有），
  // 一旦被顺手改成读 Go，这里会变成 503 或丢掉 Node 的运行态。
  assert.equal(writes[0].status, 200);
  assert.equal(typeof writes[0].payload.runtime.state, 'string');
  assert.equal(typeof writes[0].payload.runtime.generationsOnHost, 'number');
});
