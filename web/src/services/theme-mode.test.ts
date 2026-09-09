import assert from 'node:assert/strict';
import test from 'node:test';

import {
  THEME_ATTRIBUTE,
  readThemeMode,
  subscribeThemeMode,
} from './theme-mode';
import { ANTD_COLOR_THEMES, buildAntdColorTheme } from '@/theme/antd-theme';

function fakeHost(value: string | null) {
  return { getAttribute: (name: string) => (name === THEME_ATTRIBUTE ? value : null) };
}

test('readThemeMode 只认 dark，其余一律按浅色', () => {
  assert.equal(readThemeMode(fakeHost('dark')), 'dark');
  assert.equal(readThemeMode(fakeHost('light')), 'light');
  // 未标注 data-theme 时对应 design-tokens.css 的裸 :root（浅色）
  assert.equal(readThemeMode(fakeHost(null)), 'light');
  assert.equal(readThemeMode(fakeHost('Dark')), 'light');
});

test('无 MutationObserver 的宿主下订阅退化为空操作而不是抛错', () => {
  const original = (globalThis as any).MutationObserver;
  delete (globalThis as any).MutationObserver;
  try {
    const unsubscribe = subscribeThemeMode(() => {
      assert.fail('不应有回调');
    }, fakeHost('dark'));
    assert.equal(typeof unsubscribe, 'function');
    unsubscribe();
  } finally {
    if (original) (globalThis as any).MutationObserver = original;
  }
});

test('订阅只在取值真正变化时通知，且能取消', () => {
  const original = (globalThis as any).MutationObserver;
  let trigger: (() => void) | null = null;
  let disconnected = false;
  (globalThis as any).MutationObserver = class {
    constructor(private cb: () => void) {
      trigger = () => this.cb();
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  };
  try {
    let value: string | null = 'light';
    const host = { getAttribute: () => value };
    const seen: string[] = [];
    const unsubscribe = subscribeThemeMode((mode) => seen.push(mode), host);

    trigger!();
    assert.deepEqual(seen, [], '同值重复写入不应通知');

    value = 'dark';
    trigger!();
    value = 'dark';
    trigger!();
    assert.deepEqual(seen, ['dark'], '连续同值只通知一次');

    value = 'light';
    trigger!();
    assert.deepEqual(seen, ['dark', 'light']);

    unsubscribe();
    assert.equal(disconnected, true);
  } finally {
    if (original) (globalThis as any).MutationObserver = original;
    else delete (globalThis as any).MutationObserver;
  }
});

test('两套 antd 颜色主题的键集必须一致，否则切换后会残留上一主题取值', () => {
  const { light, dark } = ANTD_COLOR_THEMES;
  assert.deepEqual(Object.keys(light.token).sort(), Object.keys(dark.token).sort());
  assert.deepEqual(
    Object.keys(light.components).sort(),
    Object.keys(dark.components).sort(),
  );
  for (const name of Object.keys(light.components)) {
    assert.deepEqual(
      Object.keys(light.components[name]).sort(),
      Object.keys(dark.components[name]).sort(),
      `组件 ${name} 的深浅键集不一致`,
    );
  }
});

test('buildAntdColorTheme 深色取值确实不同于浅色', () => {
  const light = buildAntdColorTheme('light');
  const dark = buildAntdColorTheme('dark');
  assert.notEqual(light.components.Card.colorBgContainer, dark.components.Card.colorBgContainer);
  assert.notEqual(light.components.Table.headerColor, dark.components.Table.headerColor);
  assert.notEqual(light.components.Segmented.itemSelectedBg, dark.components.Segmented.itemSelectedBg);
});
