// 完整页面内容探测：脚本/Canvas/CSS 动画只影响提示，不影响捕获本身。

import { describe, expect, test } from 'bun:test';
import {
  describeScriptDependentReasons,
  detectScriptDependentHtml
} from './capture-content-probe';

describe('detectScriptDependentHtml', () => {
  test('识别脚本、Canvas 与 CSS 动画', () => {
    expect(detectScriptDependentHtml('<script>draw()</script><canvas></canvas>')).toEqual([
      'script',
      'canvas'
    ]);
    expect(detectScriptDependentHtml('<style>@keyframes fade {}</style>')).toEqual(['animation']);
    expect(detectScriptDependentHtml('<div style="animation: fade 1s"></div>')).toEqual([
      'animation'
    ]);
  });

  test('忽略注释与普通静态标记', () => {
    expect(detectScriptDependentHtml('<!-- <script>demo</script> --><p>hi</p>')).toEqual([]);
    expect(detectScriptDependentHtml('<div>animation: none</div>')).toEqual([]);
    expect(detectScriptDependentHtml('')).toEqual([]);
  });
});

describe('describeScriptDependentReasons', () => {
  test('拼出中文原因', () => {
    expect(describeScriptDependentReasons(['script', 'canvas', 'animation'])).toBe(
      '脚本、Canvas、CSS 动画'
    );
  });
});
