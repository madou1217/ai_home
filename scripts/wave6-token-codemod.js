/* Wave 6 codemod: 迁移 web/src 下旧 token 别名 var(--app-*) / var(--m-*) / var(--radius-*)
 * 到 --hos-* 等价物,形式 var(--hos-xxx, <原解析值>)。
 * 范围: web/src 下所有 .css(含 .module.css),排除 components/chat/chat.module.css。
 * 用法: node scripts/wave6-token-codemod.js [--apply]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'web', 'src');
const EXCLUDE = path.normalize('components/chat/chat.module.css');

const MOBILE_FONT = "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif";
const MOBILE_MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";
const MOBILE_SH_SM = '0 1px 3px rgba(27, 27, 43, .06), 0 1px 2px rgba(27, 27, 43, .04)';

// 默认映射: token 名 -> [hos 名, 解析值兜底]
const MAP = {
  // --app-*(design-tokens.css legacy 别名的解析值;语义类经 --hos 桥接保持深色自适应)
  'app-bg': ['hos-bg', '#f8fafc'],
  'app-sidebar-raised': ['hos-surface-raised', '#fbfcfd'],
  'app-surface': ['hos-surface', '#ffffff'],
  'app-surface-raised': ['hos-surface-raised', '#fbfcfd'],
  'app-surface-muted': ['hos-surface-muted', '#f1f5f9'],
  'app-border': ['hos-border', '#e2e8f0'],
  'app-border-strong': ['hos-border-strong', '#cbd5e1'],
  'app-text': ['hos-text', '#1e293b'],
  'app-heading': ['hos-heading', '#0f172a'],
  'app-muted': ['hos-muted', '#64748b'],
  'app-muted-strong': ['hos-muted-strong', '#475569'],
  'app-primary': ['hos-blue-700', '#0a59f7'],
  'app-primary-soft': ['hos-primary-soft', 'rgba(10, 89, 247, 0.08)'],
  'app-warning': ['hos-orange-600', '#d97706'],
  'app-danger': ['hos-red-600', '#dc2626'],
  'app-shadow-soft': ['hos-shadow-soft', '0 8px 24px rgba(15, 23, 42, 0.10)'],
  'app-radius': ['hos-radius-md', '16px'],
  'app-radius-sm': ['hos-radius-sm', '12px'],
  // --app-text-secondary 从未定义且无兜底: 渲染 = unset(inherit),保持语义不变
  'app-text-secondary': ['hos-text-secondary', 'inherit'],
  // --app-success-soft 从未定义,兜底即解析值
  'app-success-soft': ['hos-status-online-soft', 'rgba(34, 197, 94, 0.08)'],
  // --m-*(mobile-cards.css :root 定义的解析值)
  'm-font': ['hos-mobile-font', MOBILE_FONT],
  'm-mono': ['hos-mobile-mono', MOBILE_MONO],
  'm-bg': ['hos-mobile-bg', '#f1f1f7'],
  'm-surface': ['hos-white', '#ffffff'],
  'm-surface-2': ['hos-mobile-surface-2', '#fafaff'],
  'm-ink': ['hos-surface-dark-900', '#1b1b2b'],
  'm-ink-2': ['hos-gray-600', '#5a5a72'],
  'm-ink-3': ['hos-gray-400', '#8b8ba3'],
  'm-ink-4': ['hos-mobile-ink-4', '#b6b6c8'],
  'm-line': ['hos-ink-100', '#ececf4'],
  'm-line-2': ['hos-mobile-line-2', '#e2e2ee'],
  'm-acc': ['hos-orange-500', '#d97757'],
  'm-run': ['hos-mobile-run', '#13a65a'],
  'm-radius': ['hos-mobile-radius', '18px'],
  'm-sh-xs': ['hos-mobile-shadow-xs', '0 1px 2px rgba(27, 27, 43, .05)'],
  'm-sh-sm': ['hos-mobile-shadow-sm', MOBILE_SH_SM],
  // --radius-*(原始刻度) → 等值 --hos-radius-*
  'radius-xs': ['hos-radius-2xs', '6px'],
  'radius-sm': ['hos-radius-xs', '8px'],
  'radius-md': ['hos-radius-10', '10px'],
  'radius-lg': ['hos-radius-sm', '12px'],
  'radius-xl': ['hos-radius-md', '16px'],
  'radius-pill': ['hos-radius-pill', '999px'],
};

// project-workbench 所在 chunk 不加载 mobile-cards.css,--m-* 在那里未定义,
// 作者写的 var(--color-*) 兜底才是实际渲染值(且随深色主题自适应) —— 保留该语义。
const WORKBENCH = path.normalize('features/project-workbench/project-workbench.module.css');
const WORKBENCH_SPECIAL = new Map(Object.entries({
  'var(--m-bg, var(--color-bg))': 'var(--hos-bg, #f8fafc)',
  'var(--m-line, var(--color-border))': 'var(--hos-border, #e2e8f0)',
  'var(--m-surface, var(--color-surface-raised))': 'var(--hos-surface-raised, #fbfcfd)',
  'var(--m-ink, var(--color-text))': 'var(--hos-text, #1e293b)',
  // --color-text-secondary/tertiary 从未定义: 链上整体 invalid → inherit,保持语义不变
  'var(--m-ink-2, var(--color-text-secondary))': 'var(--hos-text-secondary, inherit)',
  'var(--m-ink-3, var(--color-text-tertiary))': 'var(--hos-text-tertiary, inherit)',
  'var(--m-mono, monospace)': `var(--hos-mobile-mono, ${MOBILE_MONO})`,
  "var(--m-mono, 'JetBrains Mono', monospace)": `var(--hos-mobile-mono, ${MOBILE_MONO})`,
}));

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith('.css')) yield p;
  }
}

// 对单份源码执行旧别名迁移,返回 { out, total, report }。
// special: 可选 Map(规范化表达式 -> 替换文本),用于文件级特判。
const VAR_RE = /var\(\s*--(app|m|radius)-/g;

function migrateSource(src, rel, special) {
  let out = '';
  let last = 0;
  let total = 0;
  const report = new Map();
  VAR_RE.lastIndex = 0;
  let m;
  while ((m = VAR_RE.exec(src))) {
    // 平衡括号提取完整 var() 表达式
    let i = VAR_RE.lastIndex;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    if (depth !== 0) throw new Error(`unbalanced parens: ${rel} @${m.index}`);
    const expr = src.slice(m.index, i);
    const normalized = expr.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')');
    const name = /^var\(--([a-z0-9-]+)/.exec(normalized)[1];

    let replacement = null;
    if (rel === WORKBENCH && WORKBENCH_SPECIAL.has(normalized)) {
      replacement = WORKBENCH_SPECIAL.get(normalized);
    } else if (special && special.has(normalized)) {
      replacement = special.get(normalized);
    } else if (name === 'app-success') {
      // --app-success 从未定义,按用点兜底值分流
      if (normalized === 'var(--app-success, #16a34a)') replacement = 'var(--hos-green-600, #16a34a)';
      else if (normalized === 'var(--app-success, #22c55e)') replacement = 'var(--hos-status-online, #22c55e)';
    } else if (MAP[name]) {
      replacement = `var(--${MAP[name][0]}, ${MAP[name][1]})`;
    }
    if (!replacement) throw new Error(`no mapping for: ${normalized} (${rel})`);

    out += src.slice(last, m.index) + replacement;
    last = i;
    total++;
    const key = `${normalized}  =>  ${replacement}`;
    report.set(key, (report.get(key) || 0) + 1);
  }
  out += src.slice(last);
  return { out, total, report };
}

function main() {
  const apply = process.argv.includes('--apply');
  let total = 0;
  const report = new Map();

  for (const file of walk(ROOT)) {
    const rel = path.normalize(path.relative(ROOT, file));
    if (rel === EXCLUDE) continue;
    const src = fs.readFileSync(file, 'utf8');
    const { out, total: n, report: r } = migrateSource(src, rel);
    if (apply && out !== src) fs.writeFileSync(file, out);
    total += n;
    for (const [k, v] of r) report.set(k, (report.get(k) || 0) + v);
  }

  console.log(`${apply ? 'applied' : 'dry-run'}: ${total} replacements`);
  for (const [k, n] of [...report.entries()].sort()) console.log(`${String(n).padStart(4)}  ${k}`);
}

module.exports = { MAP, WORKBENCH, WORKBENCH_SPECIAL, migrateSource, walk, ROOT };
if (require.main === module) main();
