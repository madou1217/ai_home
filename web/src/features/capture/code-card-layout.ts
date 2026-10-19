// 代码美化卡片的纯布局（无 DOM 依赖，可单测）：
// 输入 shiki token，输出每一行/每个 token 的绘制坐标与卡片尺寸。
//
// 抓帧管线（iframe + modern-screenshot）对合成卡片是 O(DOM 节点) 成本：
// 300 行 HTML 的高亮结果有 4 万个 span，实测要 13s。这里改为直接排版 token，
// 成本只与 token 数线性相关，且不再需要克隆 DOM / 序列化 foreignObject。

export interface CodeCardToken {
  content: string;
  /** 缺省时用主题前景色。 */
  color?: string;
  /** shiki FontStyle 位掩码：1=italic，2=bold。 */
  fontStyle?: number;
}

export interface CodeCardSpan {
  text: string;
  /** 相对代码面板左边的 x（CSS px）。 */
  x: number;
  color: string;
  fontStyle: number;
}

export interface CodeCardLayout {
  width: number;
  height: number;
  contentWidth: number;
  /** 代码面板顶部 y（CSS px）。 */
  codeTop: number;
  /** 代码面板高度（CSS px）。 */
  codeHeight: number;
  /** 每个元素是一条视觉行，跨行由超长 token 折行产生。 */
  lines: CodeCardSpan[][];
  /** 内容超过高度上限、尾部以省略号标记。 */
  truncated: boolean;
}

export interface CodeCardLayoutOptions {
  /** 文本宽度测量（由 Canvas 注入，测试可传字符串长度近似）。 */
  measure: (text: string, fontStyle: number) => number;
  baseColor: string;
}

/** 卡片视觉与尺寸常量（ray.so 风格骨架）。 */
export const CODE_CARD_METRICS = {
  background: '#0b1120',
  padding: 40,
  radius: 16,
  titleBarHeight: 44,
  titleBarGap: 8,
  fontSize: 15,
  /** 行高倍数（与旧 CSS 的 1.7 一致）。 */
  lineHeightRatio: 1.7,
  /** 内容区最大宽度：96 个等宽字符 × 9px，与旧实现同量级。 */
  maxContentWidth: 96 * 9,
  /** 内容区最小宽度：24 个等宽字符，避免极短代码导出成窄条。 */
  minContentWidth: 24 * 9,
  /** 导出高度上限：超过的设备像素面积会拖垮移动端 Canvas。 */
  maxHeight: 4000,
  fallbackColor: '#e6edf3',
  truncationColor: '#64748b'
} as const;

export const CODE_CARD_LINE_HEIGHT = CODE_CARD_METRICS.fontSize * CODE_CARD_METRICS.lineHeightRatio;

/** 统一去公共缩进，避免整段代码被一层缩进推宽。 */
export function normalizeCodeIndent(code: string): string {
  const lines = code.replace(/\t/g, '  ').split('\n');
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^ +/)?.[0].length ?? 0);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(common)).join('\n').trim();
}

/** 把 token 折行并计算卡片尺寸。 */
export function layoutCodeCard(
  tokens: CodeCardToken[][],
  options: CodeCardLayoutOptions
): CodeCardLayout {
  const { measure, baseColor } = options;
  const { padding, titleBarHeight, titleBarGap, maxContentWidth, minContentWidth, maxHeight } =
    CODE_CARD_METRICS;

  const visualLines: CodeCardSpan[][] = [];
  let widestLine = 0;

  for (const logicalLine of tokens) {
    // 折行单元 = 空白分隔的一组 token（组内 token 之间没有空白，不能断行）。
    // shiki 会把 `12px` 拆成 `12` + `px` 两个 token；只有按「组」排版，
    // 才不会在两者之间换行。组内仍保留各自的颜色/字体。
    const groups: Array<{
      atoms: Array<{ text: string; color: string; fontStyle: number }>;
      space: boolean;
      width: number;
    }> = [];
    for (const token of logicalLine) {
      if (token.content.length === 0) continue;
      const color = token.color || baseColor;
      const fontStyle = normalizeFontStyle(token.fontStyle);
      for (const part of token.content.match(/\s+|\S+/g) ?? []) {
        const width = measure(part, fontStyle);
        const atom = { text: part, color, fontStyle };
        if (/^\s+$/.test(part)) {
          groups.push({ atoms: [atom], space: true, width });
          continue;
        }
        const last = groups[groups.length - 1];
        if (last && !last.space) {
          last.atoms.push(atom);
          last.width += width;
        } else {
          groups.push({ atoms: [atom], space: false, width });
        }
      }
    }

    let current: CodeCardSpan[] = [];
    let cursor = 0;
    const flush = () => {
      visualLines.push(current);
      widestLine = Math.max(widestLine, cursor);
      current = [];
      cursor = 0;
    };
    const append = (atom: { text: string; color: string; fontStyle: number }) => {
      current.push({ text: atom.text, x: cursor, color: atom.color, fontStyle: atom.fontStyle });
      cursor += measure(atom.text, atom.fontStyle);
    };

    for (const group of groups) {
      if (cursor + group.width <= maxContentWidth) {
        group.atoms.forEach(append);
        continue;
      }
      if (group.space) {
        // 空白放不下时丢弃并换行（行尾不留悬挂空格）。
        if (current.length > 0) flush();
        continue;
      }
      if (current.length > 0) flush();
      if (group.width <= maxContentWidth) {
        group.atoms.forEach(append);
        continue;
      }
      // 整组本身超过一行（压缩后的 HTML/超长字符串）：逐 token、再逐字符切。
      for (const atom of group.atoms) {
        const width = measure(atom.text, atom.fontStyle);
        if (cursor + width <= maxContentWidth) {
          append(atom);
          continue;
        }
        for (const char of Array.from(atom.text)) {
          const charWidth = measure(char, atom.fontStyle);
          if (cursor + charWidth > maxContentWidth && current.length > 0) flush();
          current.push({ text: char, x: cursor, color: atom.color, fontStyle: atom.fontStyle });
          cursor += charWidth;
        }
      }
    }
    flush();
  }

  if (visualLines.length === 0) visualLines.push([]);

  const contentWidth = clamp(widestLine, minContentWidth, maxContentWidth);
  const chromeHeight = padding * 2 + titleBarHeight + titleBarGap;
  const maxLines = Math.max(1, Math.floor((maxHeight - chromeHeight) / CODE_CARD_LINE_HEIGHT));

  let lines = visualLines;
  let truncated = false;
  if (visualLines.length > maxLines) {
    truncated = true;
    // 预留最后一行画省略号，明确告知内容被截断而不是静默裁掉。
    lines = visualLines.slice(0, Math.max(0, maxLines - 1));
    lines.push([
      { text: '…', x: 0, color: CODE_CARD_METRICS.truncationColor, fontStyle: 0 }
    ]);
  }

  return {
    width: padding * 2 + contentWidth,
    height: chromeHeight + lines.length * CODE_CARD_LINE_HEIGHT,
    contentWidth,
    codeTop: padding + titleBarHeight + titleBarGap,
    codeHeight: lines.length * CODE_CARD_LINE_HEIGHT,
    lines,
    truncated
  };
}

/** shiki 的 NotSet 是 -1（位掩码全 1），必须归一成 0，否则会被当成粗斜体。 */
function normalizeFontStyle(fontStyle: number | undefined): number {
  return typeof fontStyle === 'number' && fontStyle > 0 ? fontStyle : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
