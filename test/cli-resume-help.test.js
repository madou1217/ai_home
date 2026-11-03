'use strict';

// aih resume（跨 provider 会话选择器）+ 帮助文本。
//
// 守的是"能不能看懂、能不能选对"：
//   - 同一段会话被多个 provider 看到时只出现一次（原生 CLI 优先）；
//   - 编号 / id 前缀 / 标题片段都能选中，直接回车取第一条；
//   - 帮助按用途分组，且每组列宽按最长命令对齐（中文按两列算）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  dedupeSessions,
  extractUserText,
  filterSessions,
  formatRelativeTime,
  formatResumeList,
  parseResumeArgs,
  pickSession
} = require('../lib/cli/commands/resume/router');
const { createCliHelpService, displayWidth } = require('../lib/cli/commands/help/messages');

function session(id, provider, extra = {}) {
  return { id, provider, title: 'title-' + id, projectPath: '/repo', updatedAt: 1_700_000_000_000, ...extra };
}

test('同一会话被多个 provider 看到时只保留一个（原生 CLI 优先）', () => {
  const list = dedupeSessions([
    session('s1', 'workbuddy'),
    session('s1', 'codebuddy'),
    session('s1', 'codebuddycn'),
    session('s2', 'workbuddycn')
  ]);
  assert.deepEqual(list.map((item) => [item.id, item.provider]), [['s1', 'codebuddy'], ['s2', 'workbuddycn']]);
});

test('过滤：标题片段 / id 片段 / provider 都能命中，当前目录排前', () => {
  const list = [
    session('aaa-1', 'codex', { title: '部署脚本', updatedAt: 3, projectPath: '/other' }),
    session('bbb-2', 'claude', { title: '会话清理', updatedAt: 2, projectPath: '/repo' }),
    session('ccc-3', 'codex', { title: '别的事', updatedAt: 1, projectPath: '/other' })
  ];
  assert.deepEqual(filterSessions(list, '部署', 10).map((item) => item.id), ['aaa-1']);
  assert.deepEqual(filterSessions(list, 'bbb', 10).map((item) => item.id), ['bbb-2']);
  assert.deepEqual(filterSessions(list, 'claude', 10).map((item) => item.id), ['bbb-2']);
  // 无关键词时当前目录优先
  assert.deepEqual(filterSessions(list, '', 10, '/repo').map((item) => item.id), ['bbb-2', 'aaa-1', 'ccc-3']);
});

test('选择：编号 / id 前缀 / 标题 / 空回车取第一条', () => {
  const list = [session('aaa-1', 'codex', { title: '部署脚本' }), session('bbb-2', 'codex', { title: '会话清理' })];
  assert.equal(pickSession(list, '').id, 'aaa-1');
  assert.equal(pickSession(list, '2').id, 'bbb-2');
  assert.equal(pickSession(list, 'bbb').id, 'bbb-2');
  assert.equal(pickSession(list, '部署').id, 'aaa-1');
  assert.equal(pickSession(list, '9'), null);
  assert.equal(pickSession(list, 'zzz'), null);
});

test('参数：关键词与旗标分开，--json/--limit 生效', () => {
  const parsed = parseResumeArgs(['copilot', '--provider', 'codex', '--account', '2', '--limit', '5', '--json']);
  assert.equal(parsed.query, 'copilot');
  assert.equal(parsed.provider, 'codex');
  assert.equal(parsed.account, '2');
  assert.equal(parsed.limit, 5);
  assert.equal(parsed.json, true);
});

test('相对时间与列表渲染：标题、时间、id 都在', () => {
  assert.equal(formatRelativeTime(Date.now() - 90 * 1000), '1 分钟前');
  assert.equal(formatRelativeTime(Date.now() - 3 * 3600 * 1000), '3 小时前');
  const text = formatResumeList([session('aaa-1', 'codex', { title: '部署脚本' })], '/repo');
  assert.match(text, /部署脚本/);
  assert.match(text, /aaa-1/);
  assert.match(text, /codex/);
});

test('根帮助：分组齐全、关键命令都在、列对齐（中文算两列）', () => {
  const lines = [];
  const help = createCliHelpService({ log: (text) => lines.push(String(text)) });
  help.showHelp();
  const output = lines.join('\n');
  for (const heading of ['常用', '会话', '外部 harness', '账号', '网关与远程', '终端与福利', '进阶', '看细节']) {
    assert.ok(output.includes(heading), heading);
  }
  for (const command of ['aih resume', 'aih harness', 'aih <cli> resume', 'aih server config', 'aih shell', 'TAB']) {
    assert.ok(output.includes(command), command);
  }
  // 对齐的前提是"中文按两列算"：同一组里每条说明都从 2 + 列宽 开始。
  assert.equal(displayWidth('aih resume [关键词]'), 19);
  assert.equal(displayWidth('aih resume [abc]'), 16);
  const columns = new Set(
    output.split('\n')
      .filter((text) => text.startsWith('  aih '))
      .map((text) => text.indexOf('\x1b[90m'))
  );
  assert.ok(columns.size > 1); // 分组各自对齐，不是全局一个列宽
  for (const column of columns) assert.ok(column >= 18, String(column));
});

test('provider 帮助：启动/会话/账号分组，且包含 resume/fork 提示', () => {
  const lines = [];
  const help = createCliHelpService({ log: (text) => lines.push(String(text)) });
  help.showCliUsage('codex');
  const output = lines.join('\n');
  assert.match(output, /启动与会话/);
  assert.match(output, /aih codex resume/);
  assert.match(output, /aih codex fork/);
  assert.match(output, /aih codex set-mobile/);
});

test('预览：各家记录格式都能取出用户输入', () => {
  // codebuddy 家族
  assert.equal(
    extractUserText({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '把链路补完整' }] }),
    '把链路补完整'
  );
  // claude
  assert.equal(
    extractUserText({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '检查 server' }] } }),
    '检查 server'
  );
  // codex event_msg
  assert.equal(
    extractUserText({ type: 'event_msg', payload: { type: 'user_message', message: '跑一下测试' } }),
    '跑一下测试'
  );
  // assistant / 无内容 → 空
  assert.equal(extractUserText({ role: 'assistant', content: 'hi' }), '');
  assert.equal(extractUserText(null), '');
});

test('列表渲染优先用预览（有预览就不显示路径）', () => {
  const text = formatResumeList([session('aaa-1', 'codex', { preview: '继续做预览行' })], '/repo');
  assert.match(text, /继续做预览行/);
  assert.doesNotMatch(text, /\/repo/);
});
