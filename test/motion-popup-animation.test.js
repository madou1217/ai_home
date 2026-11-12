'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../web/src/styles/motion.css'), 'utf8');

function blockAfter(selector) {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `缺少选择器：${selector}`);
  return css.slice(start, css.indexOf('}', start) + 1);
}

// 回归守卫（2026-11-06）：rc-motion 在 prepare/start 之后追加 -active；
// 如果 active 阶段不在同一组 keyframes 里，antd 会把 animation-name 换回自己的，
// 动画从 0 重播 —— 下拉菜单先淡入一小截、突然归零、再淡入一次（用户看到「会闪」）。
test('slide 弹层在 active 阶段沿用同一组进场动画，不重播', () => {
  for (const selector of [
    '.ant-slide-up-appear.ant-slide-up-appear-active',
    '.ant-slide-up-enter.ant-slide-up-enter-active',
    '.ant-slide-down-appear.ant-slide-down-appear-active',
    '.ant-slide-down-enter.ant-slide-down-enter-active'
  ]) {
    const rule = blockAfter(selector);
    assert.match(rule, /animation-name:\s*aih-popup-slide-in\s*!important/);
    assert.match(rule, /animation-duration:\s*var\(--motion-base\)\s*!important/);
  }
});

test('zoom 弹层同样把 active 纳入同一组动画', () => {
  const rule = blockAfter('.ant-zoom-appear.ant-zoom-appear-active');
  assert.match(rule, /animation-name:\s*aih-popup-zoom-in/);
});
