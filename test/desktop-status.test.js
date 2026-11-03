'use strict';

// `aih desktop status`（P0）：只读采集 canonical / 影子副本 / 运行中 / 漂移。
// 关键约定：
//   1) 版本一律从 .app/Contents/Info.plist 读，不信任何缓存字段；
//   2) 运行中实例按「最外层 .app」归属（zcode 的 helper 在主 bundle 里面）；
//   3) aih 跑在投影里时，真实家目录用 os.userInfo() 兜底，不能拿投影当宿主。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveInstalledApp } = require('../lib/server/desktop-launch/desktop-app-catalog');
const { collectDesktopStatus } = require('../lib/server/desktop-launch/desktop-status');
const { looksProjectedHome, resolveAppHomeDir } = require('../lib/server/desktop-launch/desktop-host-home');
const { parseDesktopArgs, printTable } = require('../lib/cli/commands/desktop-router');

function writeApp(root, bundleName, { version, bundleId }) {
  const bundlePath = path.join(root, bundleName);
  fs.mkdirSync(path.join(bundlePath, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(bundlePath, 'Contents', 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    '  <key>CFBundleIdentifier</key><string>' + bundleId + '</string>',
    '  <key>CFBundleShortVersionString</key><string>' + version + '</string>',
    '</dict></plist>'
  ].join('\n'));
  return bundlePath;
}

function withRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-desktop-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    home: path.join(root, 'home'),
    aiHomeDir: path.join(root, 'aih')
  };
}

test('catalog 解析 ~/Applications 下的应用与版本', (t) => {
  const { home, root } = withRoot(t);
  fs.mkdirSync(home, { recursive: true });
  writeApp(path.join(home, 'Applications'), 'ZCode.app', { version: '3.17.1', bundleId: 'dev.zcode.app' });
  const entry = { key: 'zcode', providers: ['zcode'], bundleNames: ['ZCode.app'], bundleIds: ['dev.zcode.app'] };
  const resolved = resolveInstalledApp(entry, { fs, path, platform: 'darwin', homeDir: home });
  assert.equal(resolved.installed, true);
  assert.equal(resolved.version, '3.17.1');
  assert.equal(resolved.bundleId, 'dev.zcode.app');
  assert.equal(resolveInstalledApp(entry, { fs, path, platform: 'linux', homeDir: home }).installed, false);
  assert.ok(root);
});

test('投影 HOME 不当作桌面端安装根', () => {
  assert.equal(looksProjectedHome('/Users/x/.ai_home/run/auth-projections/zcode/acct_1'), true);
  assert.equal(looksProjectedHome('/Users/x/.ai_home/run/login/codebuddy/auth-1'), true);
  assert.equal(looksProjectedHome('/Users/x'), false);
  const fakeOs = { userInfo: () => ({ homedir: '/Users/real' }), homedir: () => '/Users/real' };
  assert.equal(resolveAppHomeDir({ hostHomeDir: '/Users/x/.ai_home/run/login/a', osImpl: fakeOs }), '/Users/real');
  assert.equal(resolveAppHomeDir({ hostHomeDir: '/Users/x', osImpl: fakeOs }), '/Users/x');
});

test('status 汇总 canonical / 影子 / 运行中 / 漂移', (t) => {
  const { home, aiHomeDir } = withRoot(t);
  fs.mkdirSync(path.join(aiHomeDir, 'run'), { recursive: true });
  writeApp(path.join(home, 'Applications'), 'ZCode.app', { version: '3.17.1', bundleId: 'dev.zcode.app' });
  const shadowRoot = path.join(aiHomeDir, 'run', 'zcode-shadow', 'fp-new');
  const shadowApp = writeApp(shadowRoot, 'ZCode.app', { version: '3.17.1', bundleId: 'dev.zcode.app' });
  fs.writeFileSync(path.join(shadowRoot, 'manifest.json'), JSON.stringify({ version: 4, fingerprint: 'fp-new' }));
  const oldShadow = writeApp(path.join(aiHomeDir, 'run', 'zcode-shadow', 'fp-old'), 'ZCode.app', { version: '3.16.3', bundleId: 'dev.zcode.app' });
  fs.writeFileSync(path.join(aiHomeDir, 'run', 'zcode-shadow', 'fp-old', 'manifest.json'), JSON.stringify({ version: 4, fingerprint: 'fp-old' }));

  const status = collectDesktopStatus({
    fs, path, platform: 'darwin', hostHomeDir: home, aiHomeDir,
    listProcesses: () => [
      '  123 ' + shadowApp + '/Contents/MacOS/ZCode',
      '  124 ' + shadowApp + '/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper --type=gpu',
      '  125 ' + oldShadow + '/Contents/MacOS/ZCode',
      '  126 /Applications/Safari.app/Contents/MacOS/Safari'
    ]
  });

  const zcode = status.apps.find((app) => app.key === 'zcode');
  assert.equal(zcode.version, '3.17.1');
  assert.deepEqual(status.shadows.map((item) => item.version).sort(), ['3.16.3', '3.17.1']);
  // helper 归到最外层 bundle，不额外计一份；非 aih 应用被忽略。
  const runningVersions = status.running.filter((item) => item.key === 'zcode').map((item) => item.version).sort();
  assert.deepEqual(runningVersions, ['3.16.3', '3.17.1']);
  assert.equal(status.running.some((item) => item.key === ''), false);
  const drift = status.drift.find((item) => item.key === 'zcode');
  assert.equal(drift.canonicalVersion, '3.17.1');
  assert.deepEqual(drift.runningBehind.map((item) => item.version), ['3.16.3']);
  assert.deepEqual(drift.staleShadows.map((item) => item.version), ['3.16.3']);
});

test('CLI 参数与表格输出', () => {
  assert.deepEqual(parseDesktopArgs([]), { action: 'status', json: false, help: false, unknown: [] });
  assert.equal(parseDesktopArgs(['status', '--json']).json, true);
  assert.equal(parseDesktopArgs(['--help']).help, true);
  const lines = [];
  printTable({
    apps: [{ key: 'zcode', providers: ['zcode'], installed: true, version: '3.17.1', path: '/A/ZCode.app', bundleId: 'dev.zcode.app' }],
    shadows: [{ key: 'zcode', fingerprint: 'abcdef123', version: '3.16.3' }],
    running: [{ key: 'zcode', version: '3.16.3', count: 2, source: 'shadow' }],
    drift: [{ key: 'zcode', providers: ['zcode'], canonicalVersion: '3.17.1', runningBehind: [{ version: '3.16.3', source: 'shadow', count: 2 }], staleShadows: [{ version: '3.16.3' }] }]
  }, (line) => lines.push(line));
  const text = lines.join('\n');
  assert.match(text, /canonical/);
  assert.match(text, /3\.16\.3/);
  assert.match(text, /运行中落后/);
});
