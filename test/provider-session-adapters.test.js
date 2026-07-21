const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const {
  readAgySessionMessagesFromFile,
  readGeminiSessionMessagesFromFile,
  renderProviderBlocksToLegacyContent
} = require('../lib/sessions/provider-session-adapters');

test('renderProviderBlocksToLegacyContent maps canonical blocks to stable UI markers', () => {
  const content = renderProviderBlocksToLegacyContent([
    { type: 'reasoning', title: '分析', text: '先检查 provider 原生结构' },
    {
      type: 'checklist',
      kind: 'plan',
      explanation: '统一渲染',
      items: [
        { step: '统一 thinking', status: 'completed' },
        { step: '统一 plan', status: 'in_progress' }
      ]
    },
    { type: 'plan_text', text: '1. 收敛 adapter\n2. 收敛 UI' },
    {
      type: 'task_event',
      detail: {
        taskId: 'task-1',
        status: 'completed',
        summary: '后台任务完成'
      }
    }
  ]);

  assert.match(content, /:::thinking\n## 分析\n\n先检查 provider 原生结构\n:::/);
  assert.match(content, /:::tool\{name="update_plan"\}/);
  assert.match(content, /"explanation":"统一渲染"/);
  assert.match(content, /"step":"统一 thinking","status":"completed"/);
  assert.match(content, /<proposed_plan>\n1\. 收敛 adapter\n2\. 收敛 UI\n<\/proposed_plan>/);
  assert.match(content, /<task-notification>\n\{"taskId":"task-1","status":"completed","summary":"后台任务完成"\}\n<\/task-notification>/);
});

test('readGeminiSessionMessagesFromFile reads JSONL thoughts, text, and tool calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-adapter-gemini-'));
  const filePath = path.join(root, 'session.jsonl');

  try {
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-09T01:00:00.000Z',
          content: '请统一 plan 渲染'
        }),
        JSON.stringify({
          type: 'gemini',
          timestamp: '2026-06-09T01:00:01.000Z',
          model: 'gemini-3.5-pro',
          thoughts: [{ subject: 'Layout', description: '检查 plan panel 宽度' }],
          content: [{ text: '我会先看现有组件。' }],
          toolCalls: [{
            id: 'call-1',
            name: 'read_file',
            args: { path: 'web/src/components/chat/CandidatePlanBlock.tsx' },
            resultDisplay: 'file content'
          }]
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = readGeminiSessionMessagesFromFile(filePath);

    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], {
      role: 'user',
      content: '请统一 plan 渲染',
      timestamp: '2026-06-09T01:00:00.000Z'
    });
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].model, 'gemini-3.5-pro');
    assert.match(messages[1].content, /:::thinking\n## Layout\n\n检查 plan panel 宽度\n:::/);
    assert.match(messages[1].content, /我会先看现有组件。/);
    assert.match(messages[1].content, /:::tool\{name="read_file"\}/);
    assert.match(messages[1].content, /"path":"web\/src\/components\/chat\/CandidatePlanBlock\.tsx"/);
    assert.match(messages[1].content, /:::tool-result\nfile content\n:::/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readAgySessionMessagesFromFile renders planner timeline and execution events', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-adapter-agy-'));
  const filePath = path.join(root, 'transcript.jsonl');

  try {
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: 'USER_INPUT',
          created_at: '2026-06-09T02:00:00.000Z',
          content: [
            '<USER_REQUEST>修复 plan panel</USER_REQUEST>',
            '<USER_SETTINGS_CHANGE>',
            'The user changed setting `Model Selection` from None to Claude Opus 4.6 (Thinking). No need to comment on this change if the user does not ask about it.',
            '</USER_SETTINGS_CHANGE>'
          ].join('\n')
        }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          created_at: '2026-06-09T02:00:01.000Z',
          content: '我先检查 CSS。',
          tool_calls: [{
            name: 'view_file',
            args: { file_path: '"web/src/components/chat/chat.module.css"' }
          }]
        }),
        JSON.stringify({
          type: 'VIEW_FILE',
          created_at: '2026-06-09T02:00:02.000Z',
          content: 'File Path: `file:///repo/web/src/components/chat/chat.module.css`\n.planBlock { width: 100%; }'
        }),
        JSON.stringify({
          type: 'RUN_COMMAND',
          created_at: '2026-06-09T02:00:03.000Z',
          content: 'npm test passed'
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const messages = readAgySessionMessagesFromFile(filePath);

    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], {
      role: 'user',
      content: '修复 plan panel',
      timestamp: '2026-06-09T02:00:00.000Z',
      model: 'Claude Opus 4.6 (Thinking)'
    });
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].model, 'Claude Opus 4.6 (Thinking)');
    assert.match(messages[1].content, /我先检查 CSS。/);
    assert.match(messages[1].content, /:::tool\{name="view_file"\}/);
    assert.match(messages[1].content, /"file_path":"web\/src\/components\/chat\/chat\.module\.css"/);
    assert.match(messages[1].content, /:::tool\{name="Read"\}/);
    assert.match(messages[1].content, /:::tool\{name="Terminal"\}/);
    assert.match(messages[1].content, /npm test passed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
