'use strict';

// 回归守卫（2026-10-26 真机）：WorkBuddy 内嵌运行时的解析结果必须带 bundle 分流变量。
//
// 事故形态：装好 WorkBuddy AI.app 后 native 会话仍报
// `Cannot find module '../dist/codebuddy'`。原因是该发行版把运行时放在
// `dist/codebuddy-lite-wb.mjs`，而共享入口 `bin/codebuddy` 默认 require
// `../dist/codebuddy`（CodeBuddy 那份）；官方入口用 `CODEBUDDY_FORCE_LITE_WB_BUNDLE`
// 分流，本端此前从不设它 —— 于是「App 已安装」与「App 路径可用」之间还差这一步。
//
// 本测试钉住：解析器返回的 envPatch 携带该变量，且**只在识别到 WorkBuddy 发行版时**
// 返回（product.json 的 authentication.id 必须匹配），避免误配到 CodeBuddy。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveWorkbuddyNativeCli, HOST_IDS } = require('../lib/server/workbuddy-native-cli');

// 造一个最小可识别的「App 安装根」：只需 Contents/Resources/app.asar.unpacked/cli 下的
// bin/codebuddy 与 product.json —— 解析器只读这两个文件。
function makeAppRoot(root, authId) {
  const cli = path.join(root, 'Contents', 'Resources', 'app.asar.unpacked', 'cli');
  fs.mkdirSync(path.join(cli, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(cli, 'bin', 'codebuddy'), '#!/usr/bin/env node\n', { mode: 0o755 });
  fs.writeFileSync(path.join(cli, 'product.json'), JSON.stringify({ authentication: { id: authId } }));
  return root;
}

test('resolves the WorkBuddy runtime with the lite-wb bundle env patch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-wb-cli-'));
  try {
    makeAppRoot(root, HOST_IDS.workbuddy);
    const launch = resolveWorkbuddyNativeCli('workbuddy', { platform: 'darwin', fs, volumeRoots: [], getProviderCLIConfig: () => ({ desktopClient: { macos: { installPaths: [root] } } }) });

    assert.equal(typeof launch.command, 'string');
    assert.equal(launch.prefixArgs.length, 1);
    assert.match(launch.prefixArgs[0], /app\.asar\.unpacked\/cli\/bin\/codebuddy$/);
    // 缺这一项就是「App 装了但起不来」的那个事故。
    assert.equal(launch.envPatch.CODEBUDDY_FORCE_LITE_WB_BUNDLE, '1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an installation root whose product identity is not WorkBuddy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-wb-cli-'));
  try {
    makeAppRoot(root, 'codebuddy-desktop');
    assert.throws(
      () => resolveWorkbuddyNativeCli('workbuddy', { platform: 'darwin', fs, volumeRoots: [], getProviderCLIConfig: () => ({ desktopClient: { macos: { installPaths: [root] } } }) }),
      (error) => error && error.code === 'workbuddy_native_runtime_missing'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
