'use strict';

// 应用启动权限设置的 GET 固定读 Go：Node 不再自己组装设置 / capability / 权限目录。
// 这组用例锁三件事：
//   1) Go 返回的设置与能力被映射成既有响应契约，且 Node 不重新推导权限事实；
//   2) Go 不可用（缺门面 / 方法 / 抛错 / 5xx）一律 503，没有本地回退；
//   3) Go 的领域错误（未登记应用）原样透传 400。

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleWebUiToolAppSettingsRoutes } = require('../lib/server/webui-tool-app-settings-routes');

const APP_ID = 'codex';
const PATHNAME = `/v0/webui/toolkit/apps/${APP_ID}/settings`;

function createRes() {
  const captured = { status: 0, body: null };
  return {
    captured,
    res: {
      writeHead: (status) => { captured.status = status; },
      end: (body) => { captured.body = body ? JSON.parse(body) : null; }
    }
  };
}

function goPayload(overrides = {}) {
  return {
    ok: true,
    appId: APP_ID,
    provider: APP_ID,
    label: 'ChatGPT',
    settings: {
      maxPermission: false,
      applyToHost: false,
      permissionArgs: ['--sandbox', 'workspace-write'],
      updatedAt: 1730000000000
    },
    capability: {
      maxSupported: true,
      maxArgs: ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'],
      maxReason: '',
      permissionCatalog: {
        verifiedCliVersion: '0.163.0',
        groups: { sandbox: '沙箱', approval: '审批' },
        flags: [{
          flag: '--sandbox',
          aliases: ['-s'],
          group: 'sandbox',
          groupLabel: '沙箱',
          value: 'value',
          options: ['read-only', 'workspace-write', 'danger-full-access'],
          description: '沙箱策略',
          descriptionEn: 'Sandbox policy',
          example: 'codex -s danger-full-access',
          configEquivalent: 'sandbox_mode = "danger-full-access"',
          note: ''
        }],
        conflicts: [],
        overrides: [],
        subcommandsWithoutApprovalFlag: ['exec'],
        subcommandsBlockingPermissionOverrides: ['resume', 'fork']
      },
      hostSupported: true,
      hostFileId: 'config',
      hostDisplayPath: '~/.codex/config.toml',
      hostExists: true,
      hostWritable: false,
      hostRequiresElevation: true,
      hostReason: ''
    },
    ...overrides
  };
}

function goHost(result, options = {}) {
  const calls = [];
  return {
    calls,
    getToolAppSettings: async (...args) => {
      calls.push(args);
      if (options.throws) throw new Error('go core exploded');
      return result;
    }
  };
}

async function invoke(ctx) {
  const { res, captured } = createRes();
  const handled = await handleWebUiToolAppSettingsRoutes(
    { url: PATHNAME, headers: {} },
    res,
    'GET',
    PATHNAME,
    ctx
  );
  assert.equal(handled, true, '路由必须认领该路径');
  return captured;
}

test('GET 代理 Go 并映射成既有响应契约', async () => {
  const host = goHost({ ok: true, status: 200, data: goPayload(), errorCode: '' });
  // 不提供 fs / aiHomeDir：如果 Node 还留了本地读取路径，这一条会走到默认设置（maxPermission=true）。
  const captured = await invoke({ deps: { goCoreSync: host } });

  assert.equal(captured.status, 200);
  assert.deepEqual(host.calls, [[APP_ID]], '必须只调用一次 Go，且只带 appId');
  assert.equal(captured.body.ok, true);
  assert.equal(captured.body.label, 'ChatGPT');
  // 设置来自 Go（false），不是 Node 默认值（true）。
  assert.equal(captured.body.settings.maxPermission, false);
  assert.deepEqual(captured.body.settings.permissionArgs, ['--sandbox', 'workspace-write']);
  assert.equal(captured.body.settings.updatedAt, 1730000000000);
  assert.equal(captured.body.capability.maxSupported, true);
  assert.deepEqual(captured.body.capability.maxArgs, ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']);
  assert.equal(captured.body.capability.permissionCatalog.verifiedCliVersion, '0.163.0');
  assert.equal(captured.body.capability.permissionCatalog.flags[0].description, '沙箱策略');
  assert.equal(captured.body.capability.hostFileId, 'config');
  assert.equal(captured.body.capability.hostRequiresElevation, true);
});

test('Go 门面缺失 → 503，不回落本地', async () => {
  const captured = await invoke({ deps: {} });
  assert.equal(captured.status, 503);
  assert.equal(captured.body.ok, false);
  assert.equal(captured.body.error, 'go_core_unavailable');
});

test('Go 方法缺失 → 503', async () => {
  const captured = await invoke({ deps: { goCoreSync: {} } });
  assert.equal(captured.status, 503);
  assert.equal(captured.body.error, 'go_core_unavailable');
});

test('Go 抛错 → 503', async () => {
  const host = goHost(null, { throws: true });
  const captured = await invoke({ deps: { goCoreSync: host } });
  assert.equal(captured.status, 503);
  assert.equal(captured.body.error, 'go_core_unavailable');
});

test('Go 5xx → 503，错误码优先取 Go 的领域码', async () => {
  const host = goHost({ ok: false, status: 500, data: null, body: { ok: false, error: 'tool_db_broken' }, errorCode: 'http_500' });
  const captured = await invoke({ deps: { goCoreSync: host } });
  assert.equal(captured.status, 503);
  assert.equal(captured.body.error, 'tool_db_broken');
});

test('Go 的 400 领域错误原样透传', async () => {
  const host = goHost({
    ok: false,
    status: 400,
    data: null,
    body: { ok: false, error: 'unsupported_app', message: '未登记该应用' },
    errorCode: 'http_400'
  });
  const captured = await invoke({ deps: { goCoreSync: host } });
  assert.equal(captured.status, 400);
  assert.equal(captured.body.error, 'unsupported_app');
  assert.equal(captured.body.message, '未登记该应用');
});

test('空 capability 也输出稳定形状', async () => {
  const host = goHost({
    ok: true,
    status: 200,
    data: { ok: true, appId: APP_ID, provider: APP_ID, label: 'ChatGPT', settings: {}, capability: {} }
  });
  const captured = await invoke({ deps: { goCoreSync: host } });
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body.settings.permissionArgs, []);
  assert.equal(captured.body.settings.maxPermission, true);
  assert.deepEqual(captured.body.capability.maxArgs, []);
  assert.deepEqual(captured.body.capability.permissionCatalog.flags, []);
  assert.equal(captured.body.capability.hostReason, 'host_profile_unsupported');
});
