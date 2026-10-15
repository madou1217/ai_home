const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const { pathToFileURL } = require('node:url');

const {
  diagnoseProviderSessionHookConfig,
  buildProviderSessionHookConfigPatch,
  installProviderSessionHookConfig,
  getProviderHookConfigTarget,
  isProviderSessionHookSupported
} = require('../lib/server/provider-session-hook-config');
const { AIH_PLUGIN_MARKER, buildOpenCodePluginSource } = require('../lib/server/opencode-plugin-template');

// opencode 生命周期 hook(P4):文件式插件桥的安装/诊断,经统一入口分派。
// opencode v2 把插件入口改为 default 对象({id, setup}),旧的「导出工厂函数」形态被直接拒绝,
// 事件也从 {type, properties} 改为信封 {type, data:{sessionID}};生成模板因此是双兼容对象
// (v2: setup 订阅;v1>=1.18.29: server() 旧式 hooks)。

test('opencode 被视为受支持的 hook provider(文件式,不在 JSON 清单)', () => {
  assert.equal(isProviderSessionHookSupported('opencode'), true);
  const target = getProviderHookConfigTarget('opencode', { homeDir: '/home/x' });
  assert.match(target, /\.config\/opencode\/plugin\/aih-session-hook\.js$/);
});

test('生成的插件源码含 marker + receiver URL + 双兼容入口 + 只发两类边界事件', () => {
  const src = buildOpenCodePluginSource({ receiverUrl: 'http://127.0.0.1:9527/v0/webui/session-events/provider-hook' });
  assert.match(src, new RegExp(AIH_PLUGIN_MARKER));
  assert.match(src, /provider=opencode/);
  assert.match(src, /'UserPromptSubmit'/);
  assert.match(src, /'Stop'/);
  // v2 契约:default 对象带 id 与 setup;setup 订阅 ctx.event。
  assert.match(src, /export default \{/);
  assert.match(src, /id: 'aih-session-hook'/);
  assert.match(src, /async setup\(ctx\)/);
  assert.match(src, /ctx\.event\.subscribe/);
  assert.match(src, /session\.execution\.started/);
  assert.match(src, /session\.execution\.succeeded/);
  // v1 兼容:server() 旧式 hooks + 旧事件名。
  assert.match(src, /async server\(\)/);
  assert.match(src, /session\.idle/);
  // 去重集合保留。
  assert.match(src, /aihActiveSessions/);
});

test('install → diagnose 闭环:写文件、幂等、URL 变更需重装', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-oc-plugin-'));
  try {
    // 装前:未安装
    const before = diagnoseProviderSessionHookConfig('opencode', {}, { homeDir, port: 9527 });
    assert.equal(before.supported, true);
    assert.equal(before.installed, false);
    assert.deepEqual(before.missingEvents, ['plugin-file']);

    // dry-run 不落盘
    const dry = installProviderSessionHookConfig('opencode', { homeDir, port: 9527, dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(fs.existsSync(dry.targetPath), false);

    // 真装
    const install = installProviderSessionHookConfig('opencode', { homeDir, port: 9527 });
    assert.equal(install.ok, true);
    assert.equal(install.changed, true);
    assert.equal(fs.existsSync(install.targetPath), true);
    assert.match(fs.readFileSync(install.targetPath, 'utf8'), new RegExp(AIH_PLUGIN_MARKER));

    // 装后:installed
    const after = diagnoseProviderSessionHookConfig('opencode', {}, { homeDir, port: 9527 });
    assert.equal(after.installed, true);
    assert.deepEqual(after.missingEvents, []);

    // 幂等:再 build patch changed=false
    const patch = buildProviderSessionHookConfigPatch('opencode', {}, { homeDir, port: 9527 });
    assert.equal(patch.changed, false);

    // 换端口:URL 变更 → 需重装
    const portChanged = diagnoseProviderSessionHookConfig('opencode', {}, { homeDir, port: 9999 });
    assert.equal(portChanged.installed, false);
    assert.deepEqual(portChanged.missingEvents, ['receiver-url-changed']);
  } finally {
    fs.removeSync(homeDir);
  }
});

test('诊断:旧版(v1 形)托管文件被标为 plugin-file-outdated,重装后恢复', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-oc-plugin-legacy-'));
  try {
    const pluginDir = path.join(homeDir, '.config', 'opencode', 'plugin');
    fs.ensureDirSync(pluginDir);
    // 旧模板形态:marker + 正确 URL,但导出的是工厂函数(在 opencode v2 会加载失败)。
    const legacy = [
      `// ${AIH_PLUGIN_MARKER}: AIH 托管的 opencode 会话生命周期桥(自动生成,勿手改)`,
      'const AIH_RECEIVER_URL = "http://127.0.0.1:9527/v0/webui/session-events/provider-hook";',
      'export const AihSessionHook = async () => ({ event: async () => {} });'
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(pluginDir, `${AIH_PLUGIN_MARKER}.js`), legacy, 'utf8');

    const stale = diagnoseProviderSessionHookConfig('opencode', {}, { homeDir, port: 9527 });
    assert.equal(stale.installed, false);
    assert.deepEqual(stale.missingEvents, ['plugin-file-outdated']);

    // 重装写入新模板源码 → installed 恢复。
    const install = installProviderSessionHookConfig('opencode', { homeDir, port: 9527 });
    assert.equal(install.changed, true);
    const after = diagnoseProviderSessionHookConfig('opencode', {}, { homeDir, port: 9527 });
    assert.equal(after.installed, true);
    assert.deepEqual(after.missingEvents, []);
  } finally {
    fs.removeSync(homeDir);
  }
});

// 真实导入生成的插件文件(ESM),验证 default 对象形状与事件→POST 映射。
// 这是对 opencode v2 加载契约的替身:模块必须可被 import、default 必须是带
// id/setup/server 的普通对象(v2 只读 id+setup,v1 对象入口调 server)。
async function importGeneratedPlugin(receiverUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-oc-plugin-esm-'));
  const file = path.join(dir, `${AIH_PLUGIN_MARKER}.mjs`);
  fs.writeFileSync(file, buildOpenCodePluginSource({ receiverUrl }), 'utf8');
  const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}-${Math.random()}`);
  return { mod, dir };
}

function eventStream(events, signal) {
  return (async function* generate() {
    for (const event of events) {
      if (signal && signal.aborted) return;
      yield event;
    }
  })();
}

function captureFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, catch: () => {} };
  };
  return {
    calls,
    params: () => calls.map((url) => {
      const parsed = new URL(url);
      return {
        event: parsed.searchParams.get('event'),
        sessionId: parsed.searchParams.get('sessionId'),
        provider: parsed.searchParams.get('provider')
      };
    }),
    restore: () => { globalThis.fetch = original; }
  };
}

test('v2 路径:setup 订阅信封事件(started→UserPromptSubmit,终态→Stop,每会话去重)', async () => {
  const { mod, dir } = await importGeneratedPlugin('http://127.0.0.1:9527/v0/webui/session-events/provider-hook');
  try {
    assert.equal(typeof mod.default, 'object');
    assert.equal(mod.default.id, AIH_PLUGIN_MARKER);
    assert.equal(typeof mod.default.setup, 'function');
    assert.equal(typeof mod.default.server, 'function');

    const mock = captureFetch();
    try {
      const ctx = {
        event: {
          subscribe: ({ signal }) => eventStream([
            { type: 'session.execution.started', data: { sessionID: 'ses_v2_a' } },
            { type: 'session.execution.started', data: { sessionID: 'ses_v2_a' } }, // 重复:不再发
            { type: 'session.text.delta', data: { sessionID: 'ses_v2_a' } },        // 流内事件:不发
            { type: 'session.execution.succeeded', data: { sessionID: 'ses_v2_a' } },
            { type: 'session.execution.succeeded', data: { sessionID: 'ses_v2_a' } }, // 已结束:不再发
            { type: 'session.execution.started', data: { sessionID: 'ses_v2_a' } },   // 第二轮
            { type: 'session.execution.failed', data: { sessionID: 'ses_v2_a' } },
            { type: 'session.execution.started', data: { sessionID: 'ses_v2_b' } },
            { type: 'session.execution.interrupted', data: { sessionID: 'ses_v2_b' } },
            { type: 'session.execution.failed', data: { sessionID: 'ses_v2_c' } }     // 未 started:不发 Stop
          ], signal)
        }
      };
      const cleanup = await mod.default.setup(ctx);
      assert.equal(typeof cleanup, 'function');
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.deepEqual(mock.params(), [
        { event: 'UserPromptSubmit', sessionId: 'ses_v2_a', provider: 'opencode' },
        { event: 'Stop', sessionId: 'ses_v2_a', provider: 'opencode' },
        { event: 'UserPromptSubmit', sessionId: 'ses_v2_a', provider: 'opencode' },
        { event: 'Stop', sessionId: 'ses_v2_a', provider: 'opencode' },
        { event: 'UserPromptSubmit', sessionId: 'ses_v2_b', provider: 'opencode' },
        { event: 'Stop', sessionId: 'ses_v2_b', provider: 'opencode' }
      ]);

      // setup 生效后 server() 不再注册旧式钩子(同进程双发守卫)。
      const hooks = await mod.default.server();
      assert.deepEqual(hooks, {});

      cleanup();
    } finally {
      mock.restore();
    }
  } finally {
    fs.removeSync(dir);
  }
});

test('v1 路径:server() 旧式 hooks(message 事件→UserPromptSubmit,session.idle→Stop)', async () => {
  const { mod, dir } = await importGeneratedPlugin('http://127.0.0.1:9527/v0/webui/session-events/provider-hook');
  try {
    const mock = captureFetch();
    try {
      const hooks = await mod.default.server();
      assert.equal(typeof hooks.event, 'function');

      const emit = (event) => hooks.event({ event });
      await emit({ type: 'message.updated', properties: { info: { sessionID: 'ses_v1_a' } } });
      await emit({ type: 'message.part.updated', properties: { sessionID: 'ses_v1_a' } });
      await emit({ type: 'session.idle', properties: { sessionID: 'ses_v1_a' } });
      await emit({ type: 'session.idle', properties: { sessionID: 'ses_v1_a' } });

      assert.deepEqual(mock.params(), [
        { event: 'UserPromptSubmit', sessionId: 'ses_v1_a', provider: 'opencode' },
        { event: 'Stop', sessionId: 'ses_v1_a', provider: 'opencode' }
      ]);
    } finally {
      mock.restore();
    }
  } finally {
    fs.removeSync(dir);
  }
});
