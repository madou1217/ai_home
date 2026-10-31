'use strict';

// 回归守卫（2026-10-31 真机）：WorkBuddy.app 2.165.0 的内嵌 CLI 只带
// `cli/dist/codebuddy-lite-wb.mjs`，没有 `dist/codebuddy` / `dist/codebuddy-headless`。
// bin/codebuddy 只是一层薄壳，`--version` 走早退路径还能用，进会话必崩：
//   Error: Cannot find module '../dist/codebuddy'
// 而 codebuddycn 的解析链**刻意**把内嵌件排第一（它读 workbuddy-desktop.info，
// 站点干净），于是国内站账号有了、CLI 却永远起不来。
//
// 约定：只有**真能起会话**的内嵌件才进解析链；产物不全就跳过，让后面的独立安装
// （~/.local/bin、npm 全局）接手 —— 凭据侧不会打架，materializeProviderAuth 对
// codebuddycn 本来就把凭据同时写进 workbuddy-desktop.info 与
// Tencent-Cloud.coding-copilot.info 两份。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  WORKBUDDY_BUNDLED_CLI_SUBPATH,
  collectBundledCliPathEntries,
  hasRunnableBundledCli
} = require('../lib/server/app-installers/codebuddy-bundle-cli');

function withBundle(t, layout, fn) {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-workbuddy-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  const binDir = path.join(hostHomeDir, 'Applications', 'WorkBuddy.app', ...WORKBUDDY_BUNDLED_CLI_SUBPATH);
  const distDir = path.join(binDir, '..', 'dist');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'codebuddy'), '#!/usr/bin/env node\n');
  for (const file of layout) fs.writeFileSync(path.join(distDir, file), '');
  return fn({ hostHomeDir, binDir });
}

test('产物齐全（dist/codebuddy.js）：内嵌件进解析链', (t) => withBundle(t, ['codebuddy.js'], ({ hostHomeDir, binDir }) => {
  assert.equal(hasRunnableBundledCli(fs, path, binDir), true);
  const entries = collectBundledCliPathEntries({ hostHomeDir, platform: 'darwin', path, fs });
  assert.ok(entries.includes(binDir));
}));

test('只有 lite-wb（WorkBuddy 2.165.0 真实形态）：跳过，不占解析链第一位', (t) => withBundle(t, ['codebuddy-lite-wb.mjs'], ({ hostHomeDir, binDir }) => {
  assert.equal(hasRunnableBundledCli(fs, path, binDir), false);
  const entries = collectBundledCliPathEntries({ hostHomeDir, platform: 'darwin', path, fs });
  assert.equal(entries.includes(binDir), false);
}));

test('只有 headless 入口：仍算可用（headless 通路需要它）', (t) => withBundle(t, ['codebuddy-headless'], ({ hostHomeDir, binDir }) => {
  assert.equal(hasRunnableBundledCli(fs, path, binDir), true);
  assert.ok(collectBundledCliPathEntries({ hostHomeDir, platform: 'darwin', path, fs }).includes(binDir));
}));

test('目录形式的入口（dist/codebuddy/index.js）同样认', (t) => withBundle(t, [], ({ hostHomeDir, binDir }) => {
  fs.mkdirSync(path.join(binDir, '..', 'dist', 'codebuddy'), { recursive: true });
  fs.writeFileSync(path.join(binDir, '..', 'dist', 'codebuddy', 'index.js'), '');
  assert.equal(hasRunnableBundledCli(fs, path, binDir), true);
}));

test('非 macOS 平台不声明内嵌件路径', (t) => withBundle(t, ['codebuddy.js'], ({ hostHomeDir }) => {
  assert.deepEqual(collectBundledCliPathEntries({ hostHomeDir, platform: 'win32', path, fs }), []);
}));
