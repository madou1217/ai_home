'use strict';

/**
 * 浮动 Chat 窗口（CHAT / QUICK）的弹层层级守卫。
 *
 * 事故（2026-11-02 真机反馈）：窗口自身 z-index: 1200，antd 弹层却按默认
 * zIndexPopupBase=1000 派生（Popover 1030、Modal 1000），于是从窗口内部打开的
 * 「选择运行账号 / 选择模型」菜单渲染到窗口底下，表现为「账号模型的选择被 chat
 * 面板挡住」。修法是给这一子树把 zIndexPopupBase 抬到窗口之上。
 *
 * 这条测试锁的是不变量本身，而不是具体数值：只要窗口的 z-index 被调高却没同步
 * 抬高弹层基线，或者基线被删掉/改小，就会红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CSS_PATH = path.join(ROOT, 'web/src/features/chat-runtime/chat-mini-window.module.css');
const TSX_PATH = path.join(ROOT, 'web/src/features/chat-runtime/ChatMiniWindow.tsx');

// antd 用 zIndexPopupBase 派生各弹层层级，其中 Popover 是最低的那一档（base + 30）。
const ANTD_POPOVER_OFFSET = 30;

function readFile(file) {
  return fs.readFileSync(file, 'utf8');
}

/** `.window { ... z-index: N ... }` */
function readWindowZIndex(css) {
  const block = css.match(/\.window\s*\{([\s\S]*?)\}/);
  assert.ok(block, 'chat-mini-window.module.css 里找不到 .window 规则');
  const value = block[1].match(/z-index:\s*(\d+)\s*;/);
  assert.ok(value, '.window 必须显式声明数字 z-index（浮动窗口的层级是这条不变量的基准）');
  return Number(value[1]);
}

/** `const MINI_WINDOW_THEME: ThemeConfig = { token: { zIndexPopupBase: N } }` */
function readPopupBase(tsx) {
  const value = tsx.match(/zIndexPopupBase:\s*(\d+)/);
  assert.ok(
    value,
    'ChatMiniWindow 必须给内部弹层设置 zIndexPopupBase：否则 antd 默认的 1000 会让弹层沉到 1200 的窗口下面',
  );
  return Number(value[1]);
}

test('浮动 Chat 窗口的弹层层级高于窗口自身', () => {
  const windowZIndex = readWindowZIndex(readFile(CSS_PATH));
  const popupBase = readPopupBase(readFile(TSX_PATH));
  const popoverZIndex = popupBase + ANTD_POPOVER_OFFSET;

  assert.ok(
    popoverZIndex > windowZIndex,
    `账号/模型菜单会被窗口挡住：Popover z-index ${popoverZIndex}（base ${popupBase} + ${ANTD_POPOVER_OFFSET}）`
      + ` 必须大于窗口 z-index ${windowZIndex}`,
  );
});

test('弹层基线只作用于窗口子树，不动全局层级', () => {
  const tsx = readFile(TSX_PATH);
  // 必须包住 createPortal 的内容：包在别处（比如组件外层）会连窗口本身一起抬高。
  assert.match(
    tsx,
    /createPortal\(\s*<ConfigProvider\s+theme=\{MINI_WINDOW_THEME\}>/,
    'ConfigProvider 必须包住 createPortal 渲染的窗口内容，才能只影响窗口内部的弹层',
  );
  // 全局基线由 AntdThemeProvider 决定；这里出现第二处赋值说明有人改错了地方。
  const codeOnly = tsx
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
  assert.equal(
    (codeOnly.match(/zIndexPopupBase/g) || []).length,
    1,
    'zIndexPopupBase 只应在 MINI_WINDOW_THEME 里出现一次（全局基线归 AntdThemeProvider 管）',
  );
});
