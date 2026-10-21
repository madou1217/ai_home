// 整页静态帧源的纯逻辑：高度收敛/截断判定与静态内容判定。

import { describe, expect, test } from 'bun:test';
import { isStaticDocument, resolveContentHeight } from './dom-preview-frame-source';

describe('resolveContentHeight', () => {
  test('短页面抬到最小高度且不算截断', () => {
    expect(resolveContentHeight(20, 6000)).toEqual({ height: 64, truncated: false });
  });

  test('正常页面原样采用', () => {
    expect(resolveContentHeight(2400, 6000)).toEqual({ height: 2400, truncated: false });
  });

  test('超过上限时截断并显式标记', () => {
    expect(resolveContentHeight(9000, 6000)).toEqual({ height: 6000, truncated: true });
  });
});

describe('isStaticDocument', () => {
  test('没有文档时不缓存', () => {
    expect(isStaticDocument(null)).toBe(false);
  });
});
