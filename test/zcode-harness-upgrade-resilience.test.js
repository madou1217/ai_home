'use strict';

// 升级韧性回归：上游认的是「app_version + harness 同源成对」这一对东西，不是最新版本号。
// 矩阵实测（2026-10-31，同一账号、9s 间隔）：
//   旧 harness + 3.16.3 → 200      旧 harness + 3.17.1 → 3012
//   新 harness + 3.16.3 → 3012     新 harness + 3.17.1 → 200
// 所以缓存单位是画像 { appVersion, blocks }，学的时候成对记、发的时候成对发。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  auditZcodeHarnessDrift,
  extractZcodeHarnessBlocks,
  noteZcodeHarnessRejected,
  readZcodeHarnessSystem,
  selectZcodeHarnessProfile,
  writeZcodeHarnessSystem
} = require('../lib/server/zcode-harness-store');
const { resolveZcodeAppVersionSync } = require('../lib/account/zcode-app-version');
const { installZcodeOutboundProfile } = require('../lib/runtime/zcode-outbound-profile');

function shaped(identity, bodySize) {
  return [
    { type: 'text', text: identity },
    { type: 'text', text: '# Harness\n' + 'x'.repeat(bodySize) }
  ];
}

function makeAiHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-harness-'));
  fs.mkdirSync(path.join(root, 'run'), { recursive: true });
  return root;
}

test('identity 文案变了也照样识别（3.16.x / 3.17.1 / 未来任意文案）', () => {
  for (const identity of [
    'You are ZCode, an interactive coding agent',
    'You are ZCode, an interactive agent',
    'You are ZCode'
  ]) {
    assert.ok(extractZcodeHarnessBlocks(shaped(identity, 3000)), identity);
  }
});

test('客户端自己的 system 不会被误判成 harness', () => {
  assert.equal(extractZcodeHarnessBlocks([{ type: 'text', text: 'x'.repeat(4000) }]), null);
  assert.equal(extractZcodeHarnessBlocks([
    { type: 'text', text: 'x'.repeat(400) },
    { type: 'text', text: 'y'.repeat(3000) }
  ]), null);
  assert.equal(extractZcodeHarnessBlocks('You are ZCode'), null);
  assert.equal(extractZcodeHarnessBlocks([]), null);
});

test('画像成对落盘：版本与 harness 一起存、一起取', () => {
  const aiHomeDir = makeAiHome();
  assert.equal(writeZcodeHarnessSystem({
    aiHomeDir,
    blocks: shaped('You are ZCode, an interactive coding agent', 3100),
    appVersion: '3.16.3'
  }), true);
  assert.equal(writeZcodeHarnessSystem({
    aiHomeDir,
    blocks: shaped('You are ZCode, an interactive agent', 3170),
    appVersion: '3.17.1'
  }), true);

  const store = readZcodeHarnessSystem({ aiHomeDir });
  assert.equal(store.appVersion, '3.17.1');
  assert.deepEqual(store.profiles.map((p) => p.appVersion), ['3.17.1', '3.16.3']);
  const selected = selectZcodeHarnessProfile({ store });
  assert.equal(selected.appVersion, '3.17.1');
  assert.equal(selected.blocks[0].text, 'You are ZCode, an interactive agent');
});

test('同版本同内容不重复落盘', () => {
  const aiHomeDir = makeAiHome();
  const blocks = shaped('You are ZCode, an interactive agent', 3000);
  assert.equal(writeZcodeHarnessSystem({ aiHomeDir, blocks, appVersion: '3.17.1' }), true);
  assert.equal(writeZcodeHarnessSystem({ aiHomeDir, blocks, appVersion: '3.17.1' }), false);
});

test('某份画像被 405 拒后，自动退到上一份（升级不再把 relay 卡死）', () => {
  const aiHomeDir = makeAiHome();
  writeZcodeHarnessSystem({ aiHomeDir, blocks: shaped('You are ZCode, an interactive coding agent', 3100), appVersion: '3.16.3' });
  writeZcodeHarnessSystem({ aiHomeDir, blocks: shaped('You are ZCode, an interactive agent', 3170), appVersion: '3.17.1' });
  const store = readZcodeHarnessSystem({ aiHomeDir });
  noteZcodeHarnessRejected('3.17.1');
  const fallback = selectZcodeHarnessProfile({ store });
  assert.equal(fallback.appVersion, '3.16.3');
});

test('旧格式缓存（顶层只有一份画像）仍可读', () => {
  const aiHomeDir = makeAiHome();
  const blocks = shaped('You are ZCode, an interactive agent', 3000);
  fs.writeFileSync(
    path.join(aiHomeDir, 'run', 'zcode-harness-system.json'),
    JSON.stringify({ appVersion: '3.17.1', capturedAt: '2026-10-30T18:10:00.120Z', blocks })
  );
  const store = readZcodeHarnessSystem({ aiHomeDir });
  assert.equal(store.appVersion, '3.17.1');
  assert.equal(store.profiles.length, 1);
  assert.equal(selectZcodeHarnessProfile({ store }).blocks.length, 2);
});

test('漂移自检：版本错配才告警，且只报一次', () => {
  const harness = { blocks: shaped('You are ZCode, an interactive agent', 3000), appVersion: '3.16.3' };
  assert.equal(auditZcodeHarnessDrift({ harness, appVersion: '3.17.1' }).repeated, false);
  assert.equal(auditZcodeHarnessDrift({ harness, appVersion: '3.17.1' }).repeated, true);
  assert.equal(auditZcodeHarnessDrift({ harness, appVersion: '3.16.3' }), null);
  assert.equal(auditZcodeHarnessDrift({ harness: null, appVersion: '3.17.1' }), null);
});

test('本机安装版是真值：直接采用并回写缓存（不做版本下限抬升）', () => {
  const aiHomeDir = makeAiHome();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-home-'));
  const plistDir = path.join(home, 'Applications', 'ZCode.app', 'Contents');
  fs.mkdirSync(plistDir, { recursive: true });
  fs.writeFileSync(
    path.join(plistDir, 'Info.plist'),
    '<plist><dict><key>CFBundleShortVersionString</key><string>3.16.3</string></dict></plist>'
  );
  fs.writeFileSync(
    path.join(aiHomeDir, 'run', 'zcode-app-version.json'),
    JSON.stringify({ version: '3.17.1', fetchedAtMs: Date.now() })
  );
  const resolved = resolveZcodeAppVersionSync({ fs, path, aiHomeDir, home, platform: 'darwin' });
  assert.equal(resolved, '3.16.3');
  const cached = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'run', 'zcode-app-version.json'), 'utf8'));
  assert.equal(cached.version, '3.16.3');
});

test('CLI 通道（aih zcode -p）：plan 请求换成画像，其它请求原样', () => {
  const aiHomeDir = makeAiHome();
  writeZcodeHarnessSystem({
    aiHomeDir,
    blocks: shaped('You are ZCode, an interactive agent', 3170),
    appVersion: '3.17.1'
  });
  const storePath = path.join(aiHomeDir, 'run', 'zcode-harness-system.json');
  let seen = null;
  const fake = { fetch: async (url, init) => { seen = { url, init }; return { status: 200 }; } };
  assert.equal(installZcodeOutboundProfile({ storePath, globalObj: fake }), true);

  fake.fetch('https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'x-zcode-app-version': '0.17.1', 'user-agent': 'ZCode/0.17.1 ai-sdk' },
    body: JSON.stringify({ model: 'GLM-5.3-Flash', system: shaped('You are ZCode, an interactive agent', 10), messages: [] })
  });
  assert.equal(seen.init.headers['x-zcode-app-version'], '3.17.1');
  assert.equal(seen.init.headers['user-agent'], 'ZCode/3.17.1 ai-sdk');
  assert.deepEqual(JSON.parse(seen.init.body).system.map((b) => b.text.length), [35, 3180]);

  fake.fetch('https://example.com/v1/other', {
    method: 'POST',
    headers: { 'x-zcode-app-version': '0.17.1' },
    body: '{"a":1}'
  });
  assert.equal(seen.init.headers['x-zcode-app-version'], '0.17.1');
  assert.equal(seen.init.body, '{"a":1}');
});

test('CLI 通道：画像缺失时一个字节都不改', () => {
  const aiHomeDir = makeAiHome();
  let seen = null;
  const fake = { fetch: async (url, init) => { seen = { url, init }; return { status: 200 }; } };
  installZcodeOutboundProfile({
    storePath: path.join(aiHomeDir, 'run', 'zcode-harness-system.json'),
    globalObj: fake
  });
  fake.fetch('https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'x-zcode-app-version': '0.17.1' },
    body: '{"model":"x","system":"y"}'
  });
  assert.equal(seen.init.headers['x-zcode-app-version'], '0.17.1');
  assert.equal(seen.init.body, '{"model":"x","system":"y"}');
});
