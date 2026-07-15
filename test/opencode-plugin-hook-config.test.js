const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const {
  diagnoseProviderSessionHookConfig,
  buildProviderSessionHookConfigPatch,
  installProviderSessionHookConfig,
  getProviderHookConfigTarget,
  isProviderSessionHookSupported
} = require('../lib/server/provider-session-hook-config');
const { AIH_PLUGIN_MARKER, buildOpenCodePluginSource } = require('../lib/server/opencode-plugin-template');

// opencode 生命周期 hook(P4):文件式插件桥的安装/诊断,经统一入口分派。

test('opencode 被视为受支持的 hook provider(文件式,不在 JSON 清单)', () => {
  assert.equal(isProviderSessionHookSupported('opencode'), true);
  const target = getProviderHookConfigTarget('opencode', { homeDir: '/home/x' });
  assert.match(target, /\.config\/opencode\/plugin\/aih-session-hook\.js$/);
});

test('生成的插件源码含 marker + receiver URL + 只发两类边界事件', () => {
  const src = buildOpenCodePluginSource({ receiverUrl: 'http://127.0.0.1:9527/v0/webui/session-events/provider-hook' });
  assert.match(src, new RegExp(AIH_PLUGIN_MARKER));
  assert.match(src, /provider=opencode/);
  assert.match(src, /'UserPromptSubmit'/);
  assert.match(src, /'Stop'/);
  assert.match(src, /export const AihSessionHook/);
  // idle 才 Stop、首个产出事件才 turn-started(去重)。
  assert.match(src, /session\.idle/);
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
