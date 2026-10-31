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

const STATUS_WIDTH = 8;   // 「● 运行中」/「✔ 已结束」= 图标+空格+6 列，表头与行共用
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

  // 默认把会话ID 完整显示（UUID 36 位）；窗口变窄时按 36 → 24 → 16 → 0 逐级压缩，
  // 最后才去动 provider / 账号。项目列在放不下时最先让位。
  const layoutFor = (idWidth, showProject, titleMin) => {
    const seps = 3 + (idWidth > 0 ? 1 : 0) + (showProject ? 1 : 0);
    const fixed = STATUS_WIDTH + PROVIDER_WIDTH + ACCOUNT_WIDTH + idWidth
      + (showProject ? PROJECT_WIDTH : 0) + seps * 2;
    return { idWidth, showProject, title: total - fixed, titleMin, fixed };
  };

  const order = [
    [36, true], [36, false], [24, false], [16, false], [0, false]
  ];
  for (const [idWidth, project] of order) {
    const candidate = layoutFor(idWidth, options.grouped === true ? false : project, 20);
    // 项目列只在标题还有 30 列以上时才出现（ID 优先完整显示）。
    const minTitle = project ? 30 : 20;
    if (candidate.title >= minTitle) {
      return { status: STATUS_WIDTH, provider: PROVIDER_WIDTH, account: ACCOUNT_WIDTH, title: candidate.title, id: idWidth, project: candidate.showProject ? PROJECT_WIDTH : 0 };
    }
  }
  for (const [idWidth, project] of order) {
    const candidate = layoutFor(idWidth, options.grouped === true ? false : project, 10);
    if (candidate.title >= 10) {
      return { status: STATUS_WIDTH, provider: PROVIDER_WIDTH, account: ACCOUNT_WIDTH, title: candidate.title, id: idWidth, project: candidate.showProject ? PROJECT_WIDTH : 0 };
    }
  }

  // 极窄：丢项目、丢 ID，再压账号/provider，标题保底 10。
  let account = 10;
  let provider = PROVIDER_WIDTH;
  const fixed = STATUS_WIDTH + provider + account + 3 * 2;
  if (total - fixed < 10) provider = 9;
  if (total - (STATUS_WIDTH + provider + account + 6) < 10) account = 8;
  if (total - (STATUS_WIDTH + provider + account + 6) < 10) provider = 8;
  const widthFixed = STATUS_WIDTH + provider + account + 6;
  return { status: STATUS_WIDTH, provider, account, title: Math.max(10, total - widthFixed), id: 0, project: 0 };
}

function resolveRowCells(row, options = {}) {
  const live = Boolean(row && row.live);
  const title = String((row && (row.description || row.label || row.title)) || '').trim();
  // 会话ID = **harness（原生）会话 id**，不是 tmux/pane 名：以后换 herdr 等后端也一样。
  // tmux/pane 名只出现在详情里（d 键）。
  const nativeId = String((row && (row.agentSessionId || row.nativeSessionId)) || '').trim();
  const rawId = nativeId || '—';
  const statusLabel = String((row && row.statusLabel) || (live ? '运行中' : '空闲')).trim();
  const statusIcon = String((row && row.statusIcon) || (live ? '●' : '○')).trim();
  const projectPath = String((row && row.path) || '').trim().replace(/[\\/]+$/, '');
  const project = projectPath ? projectPath.split(/[\\/]/).pop() : '';
  return {
    live,
    status: statusIcon + ' ' + statusLabel,
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
