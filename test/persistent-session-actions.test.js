'use strict';

// 选中会话后的小命令：c 复制会话ID、y 复制进入命令、d 看详情。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describePickerRow,
  parseSessionPickerKey,
  runPickerRowAction
} = require('../lib/cli/services/ai-cli/persistent-session-list');
const { copyText } = require('../lib/runtime/clipboard-copy');

const ROW = {
  live: true,
  cliName: 'claude',
  cliAccountId: '.aih-server',
  description: '✳ 本地合并取代 AWS',
  agentSessionId: '01a176a2-edbc-7ae2-b7d0-5d084d0c28fe',
  path: '/Users/model/projects/feature/ai_home',
  name: 'p-ai_home-1z0bk3-mvva10v9-19ug'
};

test('按键：c / y / d 映射到复制 ID / 复制命令 / 详情，旧按键不变', () => {
  assert.equal(parseSessionPickerKey('c').action, 'copy-id');
  assert.equal(parseSessionPickerKey('y').action, 'copy-command');
  assert.equal(parseSessionPickerKey('d').action, 'show-detail');
  assert.equal(parseSessionPickerKey('x').action, 'close-selected');
  assert.equal(parseSessionPickerKey('X').action, 'close-idle');
  assert.equal(parseSessionPickerKey('q').action, 'quit');
  assert.equal(parseSessionPickerKey('\u001b[A').action, 'up');
  assert.equal(parseSessionPickerKey('\r').action, 'enter');
});

test('c：把会话ID写进剪贴板，并给出提示', () => {
  const copied = [];
  const message = runPickerRowAction('copy-id', ROW, { copyText: (text) => { copied.push(text); return { ok: true }; } });
  assert.deepEqual(copied, ['01a176a2-edbc-7ae2-b7d0-5d084d0c28fe']);
  assert.match(message, /已复制会话ID/);
  assert.match(message, /01a176a2/);
});

test('y：有原生 id 复制 aih <cli> <账号> resume <id>，没有就复制 aih ss <名字>', () => {
  const copied = [];
  const copy = (text) => { copied.push(text); return { ok: true }; };
  runPickerRowAction('copy-command', ROW, { copyText: copy });
  assert.equal(copied[0], 'aih claude .aih-server resume 01a176a2-edbc-7ae2-b7d0-5d084d0c28fe');
  runPickerRowAction('copy-command', { ...ROW, agentSessionId: '' }, { copyText: copy });
  assert.equal(copied[1], 'aih ss p-ai_home-1z0bk3-mvva10v9-19ug');
});

test('d：详情包含 provider / 账号 / 路径 / id；剪贴板不可用时把内容打在提示里', () => {
  const detail = runPickerRowAction('show-detail', ROW, { copyText: () => ({ ok: true }) });
  assert.match(detail, /claude#\.aih-server/);
  assert.match(detail, /feature\/ai_home/);
  assert.match(detail, /01a176a2/);

  const failed = runPickerRowAction('copy-id', ROW, { copyText: () => ({ ok: false }) });
  assert.match(failed, /剪贴板不可用/);
  assert.match(failed, /01a176a2/);
});

test('describePickerRow：三种命令形态', () => {
  const info = describePickerRow(ROW);
  assert.equal(info.id, ROW.agentSessionId);
  assert.match(info.command, /^aih claude .aih-server resume /);
  assert.match(info.detail, /feature\/ai_home/);
  assert.equal(describePickerRow(null).id, '');
});

test('剪贴板：平台工具不可用时返回失败而不是抛错', () => {
  const result = copyText('x', { platform: 'linux', spawnSync: () => ({ status: 127 }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_clipboard_tool');
  assert.equal(copyText('', {}).ok, false);
});
