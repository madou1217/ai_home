// 代码美化卡片布局的纯函数测试：宽度/折行/高度上限/缩进归一。

import { describe, expect, test } from 'bun:test';
import {
  CODE_CARD_LINE_HEIGHT,
  CODE_CARD_METRICS,
  layoutCodeCard,
  normalizeCodeIndent,
  type CodeCardToken
} from './code-card-layout';

const measure = (text: string) => text.length * 10;
const baseColor = '#e6edf3';

function layout(tokens: CodeCardToken[][]) {
  return layoutCodeCard(tokens, { measure, baseColor });
}

describe('normalizeCodeIndent', () => {
  test('去掉所有行的公共缩进并展开 tab', () => {
    expect(normalizeCodeIndent('\n\t\t<div>\n\t\t  <span>x</span>\n\t\t</div>\n')).toBe(
      '<div>\n  <span>x</span>\n</div>'
    );
  });

  test('空代码返回空串', () => {
    expect(normalizeCodeIndent('   \n\n')).toBe('');
  });

  test('忽略空行的缩进计算', () => {
    expect(normalizeCodeIndent('    a\n\n    b')).toBe('a\n\nb');
  });
});

describe('layoutCodeCard', () => {
  test('短代码使用最小内容宽度，尺寸由行数与行高决定', () => {
    const result = layout([[{ content: 'abc' }]]);
    expect(result.contentWidth).toBe(CODE_CARD_METRICS.minContentWidth);
    expect(result.width).toBe(CODE_CARD_METRICS.padding * 2 + CODE_CARD_METRICS.minContentWidth);
    expect(result.codeTop).toBe(
      CODE_CARD_METRICS.padding + CODE_CARD_METRICS.titleBarHeight + CODE_CARD_METRICS.titleBarGap
    );
    expect(result.codeHeight).toBe(CODE_CARD_LINE_HEIGHT);
    expect(result.height).toBe(result.codeTop + result.codeHeight + CODE_CARD_METRICS.padding);
    expect(result.truncated).toBe(false);
  });

  test('无空白的相邻 token 作为一组，不在 12 / px 之间换行', () => {
    const long = 'a'.repeat(84);
    const result = layout([[
      { content: long },
      { content: ' ' },
      { content: '12' },
      { content: 'px' }
    ]]);
    expect(result.lines.length).toBe(2);
    expect(result.lines[1].map((span) => span.text)).toEqual(['12', 'px']);
  });

  test('超长行按内容区上限折行，宽度不超过上限', () => {
    const result = layout([[{ content: 'x'.repeat(200) }]]);
    const charsPerLine = Math.floor(CODE_CARD_METRICS.maxContentWidth / 10);
    expect(result.lines.length).toBe(Math.ceil(200 / charsPerLine));
    expect(result.contentWidth).toBeLessThanOrEqual(CODE_CARD_METRICS.maxContentWidth);
    expect(result.truncated).toBe(false);
  });

  test('优先在空白处折行，不切断 12px 这类语义单元', () => {
    const first = 'a'.repeat(50);
    const last = 'b'.repeat(50);
    const result = layout([[
      { content: first },
      { content: ' ' },
      { content: '12px' },
      { content: ' ' },
      { content: last }
    ]]);
    expect(result.lines.length).toBe(2);
    // 第一行保留完整 12px，第二行从完整的长 token 开始，不带悬挂空白。
    expect(result.lines[0].map((span) => span.text)).toContain('12px');
    expect(result.lines[1].map((span) => span.text)).toEqual([last]);
  });

  test('空行保留为视觉行', () => {
    const result = layout([[], [{ content: 'a' }], []]);
    expect(result.lines.length).toBe(3);
    expect(result.lines[0]).toEqual([]);
  });

  test('内容超过高度上限时截断并追加省略号', () => {
    const manyLines = Array.from({ length: 1000 }, () => [{ content: 'a' }]);
    const result = layout(manyLines);
    const maxLines = Math.floor(
      (CODE_CARD_METRICS.maxHeight -
        CODE_CARD_METRICS.padding * 2 -
        CODE_CARD_METRICS.titleBarHeight -
        CODE_CARD_METRICS.titleBarGap) /
        CODE_CARD_LINE_HEIGHT
    );
    expect(result.truncated).toBe(true);
    expect(result.lines.length).toBe(maxLines);
    expect(result.height).toBeLessThanOrEqual(CODE_CARD_METRICS.maxHeight);
    const lastLine = result.lines[result.lines.length - 1];
    expect(lastLine[0]?.text).toBe('…');
    expect(lastLine[0]?.color).toBe(CODE_CARD_METRICS.truncationColor);
  });

  test('token 未着色时回退主题前景色', () => {
    const result = layout([[{ content: 'a' }, { content: 'b', color: '#ff0000' }]]);
    expect(result.lines[0][0].color).toBe(baseColor);
    expect(result.lines[0][1].color).toBe('#ff0000');
  });

  test('shiki 的 NotSet(-1) 归一为常规字体，位掩码 1/2 保留', () => {
    const result = layout([[
      { content: 'a', fontStyle: -1 },
      { content: 'b', fontStyle: 1 },
      { content: 'c', fontStyle: 2 },
      { content: 'd', fontStyle: 3 }
    ]]);
    expect(result.lines[0].map((span) => span.fontStyle)).toEqual([0, 1, 2, 3]);
  });

  test('token 的 x 坐标按累计宽度递增', () => {
    const result = layout([[{ content: 'ab' }, { content: 'cd' }]]);
    expect(result.lines[0][0].x).toBe(0);
    expect(result.lines[0][1].x).toBe(20);
  });
});
