import assert from 'node:assert/strict';
import test from 'node:test';

import { DynamicWallpaperEngine } from './dynamic-wallpaper-engine';

/**
 * 壁纸引擎的持久化闭环测试：localStorage / document / Image 全部用最小 mock 注入，
 * 验证「保存 → 启动恢复读取 → 清除」链路与 CSS 变量应用/移除。
 */
function installBrowserMocks() {
  const store = new Map<string, string>();
  const cssProps = new Map<string, string>();
  const g = globalThis as any;
  const previous = {
    window: g.window,
    localStorage: g.localStorage,
    document: g.document,
    Image: g.Image,
  };
  g.window = g;
  g.localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
  };
  g.document = {
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => { cssProps.set(name, value); },
        removeProperty: (name: string) => { cssProps.delete(name); },
      },
    },
  };
  // 无法解码图片：onerror 使萃取结果为 null，不影响持久化断言。
  g.Image = class {
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    set src(_value: string) {
      this.onerror?.();
    }
  };
  return {
    cssProps,
    restore() {
      g.window = previous.window;
      g.localStorage = previous.localStorage;
      g.document = previous.document;
      g.Image = previous.Image;
    },
  };
}

test('saveWallpaper 持久化并可被启动恢复读取', async () => {
  const mock = installBrowserMocks();
  try {
    assert.equal(DynamicWallpaperEngine.getSavedWallpaper(), null);
    DynamicWallpaperEngine.saveWallpaper('data:image/png;base64,AAA');
    assert.equal(DynamicWallpaperEngine.getSavedWallpaper(), 'data:image/png;base64,AAA');
    // 保存即应用：壁纸图层 CSS 变量立即写入。
    assert.equal(mock.cssProps.get('--hos-custom-wallpaper'), 'url("data:image/png;base64,AAA")');
    // extractPalette 失败（mock Image onerror）不阻塞保存链路。
    await Promise.resolve();
  } finally {
    mock.restore();
  }
});

test('clearWallpaper 清除持久化与 CSS 变量', () => {
  const mock = installBrowserMocks();
  try {
    DynamicWallpaperEngine.saveWallpaper('data:image/png;base64,BBB');
    assert.equal(DynamicWallpaperEngine.getSavedWallpaper(), 'data:image/png;base64,BBB');
    DynamicWallpaperEngine.clearWallpaper();
    assert.equal(DynamicWallpaperEngine.getSavedWallpaper(), null);
    assert.equal(mock.cssProps.has('--hos-custom-wallpaper'), false);
    assert.equal(mock.cssProps.has('--hos-custom-aura'), false);
    assert.equal(mock.cssProps.has('--hos-custom-accent'), false);
  } finally {
    mock.restore();
  }
});
