'use strict';

// 手机端提示「播完一直挂在页面上」的回归守卫。
//
// antd 的 message 离场靠 wrapper 上的 `ant-message-move-up-leave` 动画驱动；曾经把进场动画
// 无条件写在 `.ant-message-notice-wrapper` 上，离场时 animation 仍是已经播完的 mhud-toast-up，
// CSSMotion 等不到新的 animationend，节点永久留在 DOM。这里锁住「自定义动画只挂 enter/appear」。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'src', 'mobile', 'styles', 'mobile-hud.css'),
  'utf8'
);

test('移动端 toast 进场动画只作用于 enter / appear', () => {
  assert.match(
    css,
    /\.ant-message-notice-wrapper\.ant-message-move-up-enter[\s\S]{0,200}?\.ant-message-notice-wrapper\.ant-message-move-up-appear[\s\S]{0,200}?animation:\s*mhud-toast-up/
  );
  // 不能有无条件的 wrapper 规则（那会覆盖 antd 的离场动画）。
  assert.doesNotMatch(
    css,
    /\.ant-message\s+\.ant-message-notice-wrapper\s*\{[^}]*animation:\s*mhud-toast-up/
  );
});

test('prefers-reduced-motion 也只关进场，不覆盖离场动画', () => {
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(block, /\.ant-message-move-up-enter/);
  assert.doesNotMatch(block, /\.ant-message-notice-wrapper\s*\{\s*animation:\s*none/);
});
