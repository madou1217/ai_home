'use strict';

// aih ss 的列渲染：固定列、显示宽度对齐、窗口缩放时只有标题列伸缩。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  displayWidth,
  formatRow,
  headerRow,
  resolveLayout,
  resolveRowCells,
  truncateDisplay
} = require('../lib/cli/services/ai-cli/session-table');

const ROW = {
  live: true,
  cliName: 'claude',
  cliAccountId: '.aih-server',
  description: '✳ 本地合并取代 AWS',
  agentSessionId: '01a176a2-edbc-7ae2-b7d0-5d084d0c28fe',
  path: '/Users/model/projects/feature/ai_home',
  name: 'p-ai_home-1z0bk3-mvva10v9-19ug'
};

function columnStarts(layout) {
  const sep = 2;
  const starts = [0];
  starts.push(starts[0] + layout.status + sep);
  starts.push(starts[1] + layout.provider + sep);
  starts.push(starts[2] + layout.account + sep);
  starts.push(starts[3] + layout.title + sep);
  if (layout.id > 0) starts.push(starts[4] + layout.id + sep);
  if (layout.project > 0) starts.push(starts[starts.length - 1] + layout.id + layout.project);
  return starts;
}

test('列宽不超过终端宽度；窄屏依次丢掉项目/ID/账号宽度', () => {
  for (const width of [50, 60, 80, 100, 140]) {
    const layout = resolveLayout(width);
    const seps = (layout.id ? 1 : 0) + (layout.project ? 1 : 0) + 3;
    const total = layout.status + layout.provider + layout.account + layout.title
      + layout.id + layout.project + seps * 2;
    assert.ok(total <= Math.max(width, 48), `${width} -> ${total}`);
  }
  assert.equal(resolveLayout(50).project, 0);
  assert.ok(resolveLayout(140).title > resolveLayout(80).title);
});

test('表头与数据行的列数、顺序完全一致（含中文）', () => {
  for (const width of [60, 80, 100, 140]) {
    const layout = resolveLayout(width);
    const split = (line) => line.split(/ {2,}/).filter(Boolean);
    const header = split(headerRow({ layout }));
    const row = split(formatRow(ROW, { layout }));
    assert.equal(header.length, row.length, `width=${width}`);
    assert.equal(header[0], '状态');
    assert.equal(header[1], 'provider');
    assert.equal(header[2], '账号');
    assert.equal(row[0], '●');
    assert.equal(row[1], 'claude');
    assert.equal(row[2], '#.aih-server');
    assert.ok(displayWidth(formatRow(ROW, { layout }).trimEnd()) <= Math.max(width, 48));
  }
});

test('中文按两列宽截断，结果不超过目标宽度', () => {
  const text = truncateDisplay('中文标题中文标题中文标题', 10);
  assert.ok(displayWidth(text) <= 10, text);
  assert.ok(text.endsWith('…'));
  assert.equal(displayWidth('中文'), 4);
});

test('按项目分组时不显示项目列，标题列变宽', () => {
  const plain = resolveLayout(100);
  const grouped = resolveLayout(100, { grouped: true });
  assert.equal(grouped.project, 0);
  assert.ok(grouped.title > plain.title);
  assert.doesNotMatch(headerRow({ layout: grouped }), /项目/);
});

test('pane 名截断显示尾部；有原生会话 id 时优先原生 id', () => {
  const cells = resolveRowCells(ROW);
  assert.equal(cells.id, '01a176a2-edbc-7ae2-b7d0-5d084d0c28fe');
  const paneOnly = resolveRowCells({ ...ROW, agentSessionId: '' });
  assert.ok(paneOnly.id.startsWith('…'));
  assert.equal(paneOnly.id.length, 13);
  assert.equal(paneOnly.account, '#.aih-server');
  assert.equal(paneOnly.status, '●');
  assert.equal(paneOnly.project, 'ai_home');
});

test('空闲会话的状态列是 ○', () => {
  assert.equal(resolveRowCells({ ...ROW, live: false }).status, '○');
});

test('picker 行与列表用同一套列（选中行有 ❯ 标记）', () => {
  const { formatSessionPickerRow } = require('../lib/cli/services/ai-cli/persistent-session-list');
  const row = formatSessionPickerRow(ROW, true, { columns: 120 });
  assert.ok(row.startsWith('❯ '));
  const cells = row.slice(2).split(/ {2,}/).filter(Boolean);
  assert.equal(cells[0], '●');
  assert.equal(cells[1], 'claude');
  assert.equal(cells[2], '#.aih-server');
  assert.match(cells[3], /本地合并取代 AWS/);
  assert.match(cells[4], /01a176a2/);
});
