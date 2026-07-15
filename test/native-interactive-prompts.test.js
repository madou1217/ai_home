const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createInteractivePromptDetector,
  parseNumberedChoicePrompt,
  parseConfirmPrompt,
  parseAcknowledgePrompt
} = require('../lib/server/native-interactive-prompts');
const { handleNativeChatRunListRequest } = require('../lib/server/webui-chat-routes');

// 通用交互 prompt 检测（选择/确认/按回车）+ 活跃 run 列表端点。
// 关键防误报契约:编号选择必须至少一行带 TUI 选择光标（❯/›/>/●），
// 否则模型回答里的「问题 + markdown 编号列表」会被误判成交互弹窗。

test('带光标的编号选择被识别为 choice prompt', () => {
  const output = [
    'Do you trust the files in this folder?',
    '',
    '❯ 1. Yes, proceed',
    '  2. No, exit'
  ].join('\n');
  const prompt = parseNumberedChoicePrompt(output);
  assert.ok(prompt);
  assert.equal(prompt.kind, 'choice');
  assert.match(prompt.question, /trust the files/i);
  assert.equal(prompt.options.length, 2);
});

test('模型回答里的 markdown 编号列表（无光标）不误报', () => {
  const output = [
    '要怎么优化这个模块?',
    '1. 拆分大函数',
    '2. 补充测试',
    '3. 减少重复代码'
  ].join('\n');
  assert.equal(parseNumberedChoicePrompt(output), null);
});

test('y/n 确认与按回车继续被识别', () => {
  const confirm = parseConfirmPrompt('Overwrite existing config? (y/N)');
  assert.ok(confirm);
  assert.equal(confirm.kind, 'confirm');
  assert.equal(confirm.options.length, 2);

  const ack = parseAcknowledgePrompt('Press Enter to continue...');
  assert.ok(ack);
  assert.equal(ack.kind, 'acknowledge');
  assert.equal(ack.options[0].send, '\r');
});

test('detector: codex plan prompt 行为保持,通用选择在其他 provider 生效', () => {
  const claudeDetector = createInteractivePromptDetector('claude');
  const event = claudeDetector.appendOutput([
    'Do you want to make this edit?',
    '❯ 1. Yes',
    '  2. No, and tell Claude what to do differently'
  ].join('\n'));
  assert.ok(event);
  assert.equal(event.type, 'interactive-prompt');
  assert.equal(event.prompt.kind, 'choice');
  // getActivePrompt 供 detached 重连恢复
  assert.ok(claudeDetector.getActivePrompt());
  const cleared = claudeDetector.clearActivePrompt('answered');
  assert.equal(cleared.type, 'interactive-prompt-cleared');
  assert.equal(claudeDetector.getActivePrompt(), null);
});

test('GET /webui/chat/runs 按 sessionId 过滤并带 activePrompt', async () => {
  const runs = [
    {
      runId: 'run-1', provider: 'opencode', accountId: '1', sessionId: 'ses_a',
      projectDirName: 'dir-a', projectPath: '/tmp/a', startedAt: 111,
      interactionMode: 'default',
      getActivePrompt: () => ({ promptId: 'p1', kind: 'choice', question: 'q?', options: [] })
    },
    { runId: 'run-2', provider: 'codex', accountId: '2', sessionId: 'ses_b', startedAt: 222 }
  ];
  let written = null;
  const ctx = {
    url: new URL('http://localhost/v0/webui/chat/runs?sessionId=ses_a'),
    res: {},
    listNativeChatRuns: () => runs,
    writeJson: (_res, status, payload) => { written = { status, payload }; }
  };
  await handleNativeChatRunListRequest(ctx);
  assert.equal(written.status, 200);
  assert.equal(written.payload.runs.length, 1);
  const run = written.payload.runs[0];
  assert.equal(run.runId, 'run-1');
  assert.equal(run.sessionId, 'ses_a');
  assert.equal(run.activePrompt.promptId, 'p1');
});
