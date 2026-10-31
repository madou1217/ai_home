'use strict';

/**
 * 持久会话列表的**固定列**渲染。
 *
 * 列顺序固定，宽度固定（标题列吃掉剩余宽度），所以：
 *   - 不同 provider 的行永远对齐；
 *   - 终端拉伸/缩放时只有标题列变长变短，其它列不跳动；
 *   - 中文按两列宽计算（东亚马赛克字符算 1）。
 *
 * 列：状态 · provider · 账号 · 会话名称（定宽，超长截断加 …） · 会话ID · 项目
 */

const STATUS_WIDTH = 4;   // 「状态」两个字 = 4 列，表头与行共用
const PROVIDER_WIDTH = 12;
const ACCOUNT_WIDTH = 14;
const ID_WIDTH = 22;
const PROJECT_WIDTH = 18;
const TITLE_MIN_WIDTH = 16;
const SEPARATOR = '  ';

function charWidth(code) {
  if (code < 0x1100) return 1;
  if (code <= 0x115f) return 2;
  if (code === 0x2329 || code === 0x232a) return 2;
  if (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) return 2;
  if (code >= 0xac00 && code <= 0xd7a3) return 2;
  if (code >= 0xf900 && code <= 0xfaff) return 2;
  if (code >= 0xfe30 && code <= 0xfe6f) return 2;
  if (code >= 0xff00 && code <= 0xff60) return 2;
  if (code >= 0xffe0 && code <= 0xffe6) return 2;
  return 1;
}

function displayWidth(text) {
  let width = 0;
  for (const char of String(text == null ? '' : text)) width += charWidth(char.codePointAt(0));
  return width;
}

/** 按显示宽度截断，末尾补 …（保证结果宽度 <= width）。 */
function truncateDisplay(text, width) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (width <= 0) return '';
  if (displayWidth(value) <= width) return value;
  let out = '';
  let used = 0;
  for (const char of value) {
    const next = charWidth(char.codePointAt(0));
    if (used + next > width - 1) break;
    out += char;
    used += next;
  }
  return out + '…';
}

function padDisplay(text, width, align = 'left') {
  const value = String(text == null ? '' : text);
  const padding = Math.max(0, width - displayWidth(value));
  return align === 'right' ? ' '.repeat(padding) + value : value + ' '.repeat(padding);
}

/**
 * 根据终端宽度决定每列宽度：固定列不变，只有标题列伸缩。
 * 窄到放不下时依次丢掉「项目」「会话ID」，保证前四列始终可读。
 */
function resolveLayout(width, options = {}) {
  const detected = Number(width)
    || Number(process.stdout && process.stdout.columns)
    || Number(process.env.COLUMNS)
    || 100;
  const total = Math.max(48, Math.min(240, detected));

  // 先按理想宽度排，放不下就按「provider → 账号 → 会话ID → 项目」的顺序收缩，
  // 保证「状态 / provider / 账号 / 会话名称」这四列永远在，且顺序不变。
  let provider = 12;
  let account = 14;
  let id = 22;
  let showProject = options.grouped !== true;
  const sepCount = (withId, withProject) => 3 + (withId ? 1 : 0) + (withProject ? 1 : 0);
  const widthOf = (withId, withProject) => 4 + provider + account + (withId ? id : 0)
    + (withProject ? 18 : 0) + sepCount(withId, withProject) * 2;

  if (widthOf(true, showProject) + TITLE_MIN_WIDTH > total) showProject = false;
  if (widthOf(true, false) + TITLE_MIN_WIDTH > total) id = 16;
  if (widthOf(true, false) + TITLE_MIN_WIDTH > total) id = 0;
  if (widthOf(false, false) + TITLE_MIN_WIDTH > total) account = 10;
  if (widthOf(false, false) + TITLE_MIN_WIDTH > total) account = 8;
  if (widthOf(false, false) + TITLE_MIN_WIDTH > total) provider = 9;
  if (widthOf(false, false) + TITLE_MIN_WIDTH > total) provider = 8;

  const title = Math.max(10, total - widthOf(id > 0, showProject));
  return {
    status: 4,
    provider,
    account,
    title,
    id,
    project: showProject ? 18 : 0
  };
}

function resolveRowCells(row, options = {}) {
  const live = Boolean(row && row.live);
  const title = String((row && (row.description || row.label || row.title)) || '').trim();
  const agentSessionId = String((row && row.agentSessionId) || '').trim();
  const paneName = String((row && row.name) || '').trim();
  // pane 名的前缀（p-<项目>-<hash>-）对所有行都一样，截断时只会看到重复前缀，
  // 所以退化显示末尾 12 位；有原生会话 id 就优先用原生 id。
  const rawId = agentSessionId || (paneName.length > 12 ? '…' + paneName.slice(-12) : paneName);
  const projectPath = String((row && row.path) || '').trim().replace(/[\\/]+$/, '');
  const project = projectPath ? projectPath.split(/[\\/]/).pop() : '';
  return {
    live,
    status: live ? '●' : '○',
    provider: String((row && (row.cliName || row.provider)) || '').trim(),
    account: (() => {
      const id = String((row && row.cliAccountId) || '').trim();
      return id ? `#${id}` : '';
    })(),
    title: title || '(无标题)',
    id: rawId,
    project
  };
}

/** 单行渲染（列表与 picker 共用，保证两处列宽一致）。 */
function formatRow(row, options = {}) {
  const layout = options.layout || resolveLayout(options.width);
  const cells = resolveRowCells(row, options);
  const parts = [
    padDisplay(cells.status, layout.status),
    padDisplay(truncateDisplay(cells.provider, layout.provider), layout.provider),
    padDisplay(truncateDisplay(cells.account, layout.account), layout.account),
    padDisplay(truncateDisplay(cells.title, layout.title), layout.title)
  ];
  if (layout.id > 0) parts.push(padDisplay(truncateDisplay(cells.id, layout.id), layout.id));
  if (layout.project > 0) parts.push(padDisplay(truncateDisplay(cells.project, layout.project), layout.project));
  return parts.join(SEPARATOR).replace(/\s+$/, '');
}

function headerRow(options = {}) {
  const layout = options.layout || resolveLayout(options.width);
  const parts = [
    padDisplay('状态', layout.status),
    padDisplay('provider', layout.provider),
    padDisplay('账号', layout.account),
    padDisplay('会话名称', layout.title)
  ];
  if (layout.id > 0) parts.push(padDisplay('会话ID', layout.id));
  if (layout.project > 0) parts.push(padDisplay('项目', layout.project));
  return parts.join(SEPARATOR).replace(/\s+$/, '');
}

module.exports = {
  displayWidth,
  formatRow,
  headerRow,
  resolveLayout,
  resolveRowCells,
  truncateDisplay
};
