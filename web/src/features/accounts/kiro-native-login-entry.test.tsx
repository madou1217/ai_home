import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { KiroNativeLoginEntry } from './KiroNativeLoginEntry';

// 入口的**渲染层**回归。
//
// 真实事故（用户实测反馈「我没有看到需要我人工批准的地方啊」）：入口曾按
// `activeProvider === 'kiro'` 只在 Kiro 档渲染，停在默认「全部」档的用户完全看不到它。
// 这条用例把「不依赖任何页面状态也要画出按钮」钉住 —— 组件一旦重新引入档位/可见性条件就会失败。

test('入口与「添加账号」同级无条件渲染：不接收任何 provider / 可见性入参也能画出按钮', () => {
  const html = renderToStaticMarkup(<KiroNativeLoginEntry />);
  assert.match(html, /Kiro 免 CLI 登录/);
  // 必须是真正可点的控件，而不是只有一段文案。
  assert.match(html, /ant-btn/);
});

test('入口文案自带 Kiro 前缀：在别的档位上也不产生歧义', () => {
  const html = renderToStaticMarkup(<KiroNativeLoginEntry onAdded={() => {}} />);
  assert.match(html, /Kiro/);
  assert.doesNotMatch(html, /activeProvider/);
});
