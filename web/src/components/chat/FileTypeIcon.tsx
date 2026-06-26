/**
 * FileTypeIcon — 自定义文件类型图标（纯 SVG，无外部图标库）
 *
 * 设计原则：
 *  - 纸张拟物风格：白色页面主体 + 折角 + 彩色扩展名标签
 *  - 颜色走设计规范 token 色系，不使用刺眼的纯色（如 JS 的 #F7DF1E）
 *  - drop-shadow 由 CSS 提供，避免 SVG filter 的 ID 冲突
 */
import { memo, useMemo } from 'react';
import { basenameLike } from './file-reference-utils';
import { getFileExtension } from './file-preview-utils';
import styles from './chat.module.css';

type FileTypeIconSize = 'small' | 'medium' | 'large';

interface FileTypeIconProps {
  filePath: string;
  size?: FileTypeIconSize;
  className?: string;
}

// ─── 扩展名 → 颜色映射 ────────────────────────────────────────────────────────
// 颜色参考 design-tokens.css，避免饱和度过高的颜色（如 JS 原来的 #F7DF1E）。
// bg: 标签底色；ink: 标签文字色

const EXT_PALETTE: Record<string, { bg: string; ink: string }> = {
  // JavaScript 生态
  js:    { bg: '#ca8a04', ink: '#fff' }, // amber-700（原黄改暗，不刺眼）
  mjs:   { bg: '#ca8a04', ink: '#fff' },
  cjs:   { bg: '#ca8a04', ink: '#fff' },
  jsx:   { bg: '#38bdf8', ink: '#0f172a' }, // sky

  // TypeScript
  ts:    { bg: '#2563eb', ink: '#fff' }, // blue-600
  tsx:   { bg: '#2563eb', ink: '#fff' },
  cts:   { bg: '#2563eb', ink: '#fff' },
  mts:   { bg: '#2563eb', ink: '#fff' },

  // CSS / Sass
  css:   { bg: '#7c3aed', ink: '#fff' }, // violet-700
  scss:  { bg: '#be185d', ink: '#fff' }, // pink-700
  sass:  { bg: '#be185d', ink: '#fff' },
  less:  { bg: '#7c3aed', ink: '#fff' },

  // HTML
  html:  { bg: '#c2410c', ink: '#fff' }, // orange-700
  htm:   { bg: '#c2410c', ink: '#fff' },
  vue:   { bg: '#059669', ink: '#fff' }, // emerald

  // Python
  py:    { bg: '#1d4ed8', ink: '#fff' }, // blue-700 (CPython blue)
  ipynb: { bg: '#d97706', ink: '#fff' }, // amber

  // Rust / Go / C
  rs:    { bg: '#9a3412', ink: '#fff' }, // rust
  go:    { bg: '#0369a1', ink: '#fff' }, // sky-700
  c:     { bg: '#374151', ink: '#fff' },
  cpp:   { bg: '#374151', ink: '#fff' },
  cs:    { bg: '#6d28d9', ink: '#fff' },
  java:  { bg: '#b45309', ink: '#fff' },
  kt:    { bg: '#7c3aed', ink: '#fff' }, // Kotlin violet
  swift: { bg: '#ea580c', ink: '#fff' }, // orange

  // Data & Config
  json:  { bg: '#0d9488', ink: '#fff' }, // teal
  yaml:  { bg: '#0d9488', ink: '#fff' },
  yml:   { bg: '#0d9488', ink: '#fff' },
  toml:  { bg: '#0d9488', ink: '#fff' },
  xml:   { bg: '#475569', ink: '#fff' },
  csv:   { bg: '#16a34a', ink: '#fff' },
  sql:   { bg: '#0369a1', ink: '#fff' },
  env:   { bg: '#4d7c0f', ink: '#fff' },

  // Shell
  sh:    { bg: '#1e293b', ink: '#e2e8f0' },
  bash:  { bg: '#1e293b', ink: '#e2e8f0' },
  zsh:   { bg: '#1e293b', ink: '#e2e8f0' },
  fish:  { bg: '#1e293b', ink: '#e2e8f0' },

  // Docs
  md:    { bg: '#475569', ink: '#fff' }, // slate
  mdx:   { bg: '#475569', ink: '#fff' },
  txt:   { bg: '#64748b', ink: '#fff' },
  pdf:   { bg: '#dc2626', ink: '#fff' },

  // Images
  png:   { bg: '#db2777', ink: '#fff' },
  jpg:   { bg: '#db2777', ink: '#fff' },
  jpeg:  { bg: '#db2777', ink: '#fff' },
  gif:   { bg: '#db2777', ink: '#fff' },
  webp:  { bg: '#db2777', ink: '#fff' },
  svg:   { bg: '#ea580c', ink: '#fff' },
  ico:   { bg: '#db2777', ink: '#fff' },

  // Build & Config
  lock:  { bg: '#64748b', ink: '#fff' },
  log:   { bg: '#64748b', ink: '#fff' },
  gitignore: { bg: '#334155', ink: '#fff' },
};

const DEFAULT_PALETTE = { bg: '#94a3b8', ink: '#fff' };

// ─── 扩展名缩短（最多 4 字符） ────────────────────────────────────────────────
function getShortExt(ext: string): string {
  const upper = ext.toUpperCase();
  if (upper.length <= 4) return upper;
  // 超长扩展名截取前 4 字符
  return upper.slice(0, 4);
}

// ─── 特殊文件名识别 ───────────────────────────────────────────────────────────
const SPECIAL_FILE_EXT: Record<string, string> = {
  dockerfile: 'dock',
  makefile:   'make',
  '.gitignore': 'git',
  '.env':      'env',
};

function getIconExtension(filePath: string): string {
  const name = basenameLike(filePath).toLowerCase();
  if (SPECIAL_FILE_EXT[name]) return SPECIAL_FILE_EXT[name];
  for (const prefix of ['.env']) {
    if (name.startsWith(prefix)) return 'env';
  }
  return getFileExtension(filePath) || 'file';
}

function getPalette(ext: string) {
  return EXT_PALETTE[ext.toLowerCase()] || DEFAULT_PALETTE;
}

// ─── SVG 图标尺寸 ─────────────────────────────────────────────────────────────
const SIZE_DIMS: Record<FileTypeIconSize, { w: number; h: number; badge: number; font: number }> = {
  small:  { w: 18, h: 22, badge: 7,  font: 4.8 },
  medium: { w: 24, h: 29, badge: 9,  font: 6.2 },
  large:  { w: 36, h: 44, badge: 13, font: 9   },
};

const SIZE_CLASS: Record<FileTypeIconSize, string> = {
  small:  styles.fileTypeIconSmall,
  medium: styles.fileTypeIconMedium,
  large:  styles.fileTypeIconLarge,
};

// ─── SVG 组件 ─────────────────────────────────────────────────────────────────
interface IconSvgProps {
  ext: string;
  size: FileTypeIconSize;
}

function IconSvg({ ext, size }: IconSvgProps) {
  const { w, h, badge, font } = SIZE_DIMS[size];
  const palette = getPalette(ext);
  const label = getShortExt(ext);

  // 几何参数（基于 w×h）
  const fold = Math.round(w * 0.32); // 折角尺寸
  const r = 1.5;                     // 圆角

  // 页面主路径（左上顺时针，右上留折角缺口）
  const body = [
    `M ${r},0`,
    `H ${w - fold}`,
    `L ${w},${fold}`,
    `V ${h - r}`,
    `Q ${w},${h} ${w - r},${h}`,
    `H ${r}`,
    `Q 0,${h} 0,${h - r}`,
    `V ${r}`,
    `Q 0,0 ${r},0`,
    'Z',
  ].join(' ');

  // 折角三角路径
  const corner = `M ${w - fold},0 L ${w},${fold} L ${w - fold},${fold} Z`;

  // 标签区（底部色带）
  const labelY = h - badge;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={ext}
    >
      {/* 页面主体 —— 白底 + 细边框 */}
      <path d={body} fill="#ffffff" stroke="#dde3ec" strokeWidth="0.7" />

      {/* 折角 —— 浅灰，模拟翻折遮蔽 */}
      <path d={corner} fill="#e8edf5" stroke="#dde3ec" strokeWidth="0.7" />

      {/* 底部彩色扩展名标签 */}
      <rect
        x="0"
        y={labelY}
        width={w}
        height={badge}
        rx={r}
        ry={r}
        fill={palette.bg}
        clipPath={`inset(0 0 -2px 0)`}
      />
      {/* 覆盖顶部圆角（让标签上边缘平齐） */}
      <rect x="0" y={labelY} width={w} height={r} fill={palette.bg} />

      {/* 扩展名文字 */}
      <text
        x={w / 2}
        y={labelY + badge * 0.72}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={palette.ink}
        fontSize={font}
        fontWeight="700"
        fontFamily="'JetBrains Mono', 'SFMono-Regular', monospace"
        letterSpacing="-0.3"
      >
        {label}
      </text>

      {/* 页面高光（顶部渐变，模拟受光面） */}
      <path
        d={[
          `M ${r},0.7`,
          `H ${w - fold}`,
          `L ${w - 0.7},${fold}`,
          `V ${h / 3}`,
          `H 0.7`,
          `V ${r}`,
          `Q 0.7,0.7 ${r},0.7`,
          'Z',
        ].join(' ')}
        fill="rgba(255,255,255,0.18)"
      />
    </svg>
  );
}

// ─── 主导出 ───────────────────────────────────────────────────────────────────
function FileTypeIcon({ filePath, size = 'medium', className = '' }: FileTypeIconProps) {
  const ext = useMemo(() => getIconExtension(filePath), [filePath]);
  const classNames = [styles.fileTypeIcon, SIZE_CLASS[size], className].filter(Boolean).join(' ');

  return (
    <span className={classNames} aria-hidden="true">
      <IconSvg ext={ext} size={size} />
    </span>
  );
}

export default memo(FileTypeIcon);
