'use strict';

// 生成会话增量事件的 Node 真值快照，供 Go 侧对拍。
//
// 用法：
//   node scripts/dump-session-events-parity-cases.js
//   node scripts/dump-session-events-parity-cases.js --out <path>
//
// 每个 case 的 records 是完整 JSONL 行（不含换行），tail 是文件末尾未完成的片段；
// cursor 是 Node readSessionEvents 实际收到的字节偏移。expected 是 Node 的原样返回，
// 因此 requiresSnapshot 省略 / 为 false 的区别也会被保留。

const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');

const { readSessionEvents } = require('../lib/sessions/session-reader');

const DEFAULT_OUT = path.join(
  __dirname,
  '..',
  'internal',
  'transport',
  'http',
  'webuisessioneventsapi',
  'testdata',
  'parity-cases.json'
);

const IMAGE_DATA = 'data:image/png;base64,AAAA';
const SESSION_TIME = '2026-11-12T10:00:00.000Z';

function line(value) {
  return JSON.stringify(value);
}

function withBytes(content, cursorMode, lines) {
  const size = Buffer.byteLength(content);
  if (cursorMode === 'eof') return size;
  if (cursorMode === 'beyond') return size + 7;
  if (cursorMode === 'mid-line') {
    return Buffer.byteLength(lines[0] + '\n') + 12;
  }
  if (Number.isInteger(cursorMode)) return cursorMode;
  return 0;
}

const CASES = [
  {
    name: 'basic-incremental',
    lines: [
      { type: 'session_meta', payload: { id: 'session-meta-ignored' } },
      {
        type: 'response_item',
        timestamp: SESSION_TIME,
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'hello <image src="a.png">world' },
            { type: 'input_image', image_url: IMAGE_DATA },
            { type: 'input_image', image_url: '  https://example.com/x.png  ' }
          ]
        }
      },
      { type: 'turn_context', timestamp: '2026-11-12T10:00:00.100Z', payload: { model: 'gpt-5.1-codex' } },
      {
        type: 'event_msg',
        timestamp: '2026-11-12T10:00:01.000Z',
        payload: {
          type: 'agent_reasoning',
          summary: [
            { type: 'summary_text', text: 'think one' },
            { type: 'summary_text', text: 'think two' },
            { type: 'other', text: 'ignored' }
          ]
        }
      },
      { type: 'response_item', timestamp: '2026-11-12T10:00:01.500Z', payload: { type: 'reasoning', text: 'raw reasoning' } },
      { type: 'event_msg', timestamp: '2026-11-12T10:00:01.500Z', payload: { type: 'agent_reasoning', text: 'raw reasoning' } },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:00:02.000Z',
        payload: { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }, { type: 'output_text', text: 'there' }] }
      },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:00:03.000Z',
        payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: JSON.stringify({ cmd: 'ls -la', workdir: '/tmp' }) }
      },
      {
        type: 'event_msg',
        timestamp: '2026-11-12T10:00:04.000Z',
        payload: {
          type: 'exec_command_end',
          call_id: 'call-1',
          cwd: '/tmp',
          command: ['bash', '-lc', 'ls -la'],
          aggregated_output: 'total 0\nChunk ID: abc\nOutput: file.txt\nmore\n'
        }
      }
    ],
    cursor: 0
  },
  {
    name: 'incremental-second-chunk',
    lines: [
      { type: 'session_meta', payload: { id: 'second-chunk' } },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:10:00.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first chunk' }] }
      },
      { type: 'turn_context', timestamp: '2026-11-12T10:10:01.000Z', payload: { model: 'gpt-5.1-codex' } },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:10:02.000Z',
        payload: { role: 'assistant', content: [{ type: 'output_text', text: 'second chunk reply' }] }
      }
    ],
    cursorAfterLines: 2
  },
  {
    name: 'dedupe-upsert',
    lines: [
      {
        type: 'event_msg',
        timestamp: '2026-11-12T10:01:00.000Z',
        payload: {
          type: 'user_message',
          message: 'hello <image>',
          images: [IMAGE_DATA],
          local_images: ['https://example.com/a.png']
        }
      },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:01:00.500Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello there' }, { type: 'input_image', image_url: 'data:image/png;base64,NEW' }]
        }
      },
      {
        type: 'event_msg',
        timestamp: '2026-11-12T10:01:00.100Z',
        payload: { type: 'user_message', message: 'hello there' }
      }
    ],
    cursor: 0
  },
  {
    name: 'synthetic-only',
    lines: [
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:02:00.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context><cwd>/tmp</cwd></environment_context>' }]
        }
      },
      { type: 'event_msg', timestamp: '2026-11-12T10:02:01.000Z', payload: { type: 'turn_aborted' } }
    ],
    cursor: 0
  },
  {
    name: 'goal-context-kept',
    lines: [
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:03:00.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<goal_context><objective>ship it</objective></goal_context>' }]
        }
      }
    ],
    cursor: 0
  },
  {
    name: 'function-call-output',
    lines: [
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:04:00.000Z',
        payload: { type: 'function_call_output', call_id: 'call-9', output: 'orphan' }
      },
      { type: 'event_msg', timestamp: '2026-11-12T10:04:01.000Z', payload: { type: 'agent_reasoning', text: 'after orphan' } }
    ],
    cursor: 0
  },
  {
    name: 'mobile-preamble',
    lines: [
      {
        type: 'event_msg',
        timestamp: '2026-11-12T10:05:00.000Z',
        payload: {
          type: 'user_message',
          message: '# Files mentioned by the user:\n\n- /tmp/codex-remote-attachments/a.png\n\n## My request for Codex:\n\nlook at this',
          images: ['/v0/webui/chat/attachments/a.png']
        }
      }
    ],
    cursor: 0
  },
  {
    name: 'tool-variants',
    lines: [
      { type: 'turn_context', timestamp: '2026-11-12T10:06:00.000Z', payload: { model: 'gpt-5.1-codex' } },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:06:01.000Z',
        payload: { type: 'function_call', name: 'read_file', call_id: 'r1', arguments: JSON.stringify({ path: '/tmp/a.txt' }) }
      },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:06:02.000Z',
        payload: { type: 'function_call', name: 'apply_patch', call_id: 'r2', arguments: JSON.stringify({ file_path: '/tmp/b.txt' }) }
      },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:06:03.000Z',
        payload: { type: 'function_call', name: 'TodoWrite', call_id: 'r3', arguments: JSON.stringify({ todos: [{ content: 'x', status: 'pending' }] }) }
      },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:06:04.000Z',
        payload: {
          type: 'function_call',
          name: 'update_plan',
          call_id: 'r4',
          arguments: JSON.stringify({ explanation: 'why', plan: [{ step: 'a', status: 'pending' }] })
        }
      },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:06:05.000Z',
        payload: {
          type: 'function_call',
          name: 'request_user_input',
          call_id: 'r5',
          arguments: JSON.stringify({ questions: [{ id: 'q1', question: 'Q?' }] })
        }
      },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:06:06.000Z',
        payload: {
          type: 'function_call',
          name: 'spawn_agent',
          call_id: 'r6',
          arguments: JSON.stringify({ task_name: 'child' }),
          subagent: { sessionId: 'child-1', agentPath: '/tmp/agent', agentNickname: 'nick', agentRole: 'worker', status: 'running', createdAt: 1700000000000 }
        }
      },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:06:07.000Z',
        payload: { type: 'function_call', name: 'create_goal', call_id: 'r7', arguments: JSON.stringify({ objective: 'win' }) }
      },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:06:08.000Z',
        payload: { type: 'function_call', name: 'write_stdin', call_id: 'r8', arguments: '{}' }
      },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:06:09.000Z',
        payload: { type: 'function_call', name: 'unknown_tool', call_id: 'r9', arguments: JSON.stringify({ payload: 'x'.repeat(4100) }) }
      }
    ],
    cursor: 0
  },
  {
    name: 'tool-argument-edge-cases',
    lines: [
      { type: 'turn_context', timestamp: '2026-11-12T10:12:00.000Z', payload: { model: 'gpt-5.1-codex' } },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:12:01.000Z',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'e1',
          arguments: JSON.stringify({ path: '/must-not-be-used', cmd: 'real-command' })
        }
      },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:12:02.000Z',
        payload: { type: 'function_call', name: 'TodoWrite', call_id: 'e2', arguments: JSON.stringify({ todos: null }) }
      },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:12:03.000Z',
        payload: { type: 'function_call', name: 'spawn_agent', call_id: 'e3', arguments: '{}', subagent: {} }
      },
      {
        type: 'event_msg',
        timestamp: '2026-11-12T10:12:04.000Z',
        payload: {
          type: 'exec_command_end',
          call_id: 'e1',
          cwd: '   ',
          command: [],
          aggregated_output: '  spaced output  '
        }
      }
    ],
    cursor: 0
  },
  {
    name: 'numeric-and-falsy-fields',
    lines: [
      {
        type: 'event_msg',
        timestamp: 1700000000123,
        payload: { type: 'user_message', message: 'numeric timestamp' }
      },
      { type: 'response_item', timestamp: '2026-11-12T10:13:01.000Z', payload: { type: 'reasoning', text: 0 } },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:13:02.000Z',
        payload: { type: 'agent_reasoning', summary: [{ type: 'summary_text', text: '' }], text: 'fallback text' }
      }
    ],
    cursor: 0
  },
  {
    name: 'cursor-mid-line',
    lines: [
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:14:00.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] }
      },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:14:01.000Z',
        payload: { role: 'assistant', content: [{ type: 'output_text', text: 'second' }] }
      },
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:14:02.000Z',
        payload: { role: 'assistant', content: [{ type: 'output_text', text: 'third' }] }
      }
    ],
    cursorMode: 'mid-line'
  },
  {
    name: 'valid-tail-no-newline',
    lines: [
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:07:00.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'complete line' }] }
      }
    ],
    tail: line({
      type: 'response_item',
      timestamp: '2026-11-12T10:07:01.000Z',
      payload: { role: 'assistant', content: [{ type: 'output_text', text: 'unterminated but valid' }] }
    }),
    cursor: 0
  },
  {
    name: 'partial-tail',
    lines: [
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:08:00.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'before partial' }] }
      }
    ],
    tail: '{"type":"response_item","payload":{"type":"reasoning","text":"半',
    cursor: 0
  },
  {
    name: 'cursor-at-eof',
    lines: [
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:09:00.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'done' }] }
      }
    ],
    cursorMode: 'eof'
  },
  {
    name: 'cursor-beyond',
    lines: [
      {
        type: 'response_item',
        timestamp: '2026-11-12T10:11:00.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'truncated' }] }
      }
    ],
    cursorMode: 'beyond'
  }
];

function buildContent(testCase) {
  const complete = testCase.lines.map((record) => line(record) + '\n').join('');
  return complete + (testCase.tail || '');
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outPath = outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : DEFAULT_OUT;
  const fixture = {
    version: 1,
    generatedBy: 'scripts/dump-session-events-parity-cases.js',
    cases: []
  };
  const previousHome = process.env.REAL_HOME;
  try {
    for (const testCase of CASES) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-events-parity-'));
      const sessionId = '11111111-2222-4333-8444-' + String(fixture.cases.length + 1).padStart(12, '0');
      const directory = path.join(home, '.codex', 'sessions', '2026', '11', '12');
      fs.ensureDirSync(directory);
      const content = buildContent(testCase);
      fs.writeFileSync(path.join(directory, 'rollout-2026-11-12T10-00-00-' + sessionId + '.jsonl'), content);
      process.env.REAL_HOME = home;

      let cursor;
      if (testCase.cursorAfterLines !== undefined) {
        cursor = Buffer.byteLength(testCase.lines.slice(0, testCase.cursorAfterLines).map((record) => line(record) + '\n').join(''));
      } else if (testCase.cursorMode) {
        cursor = withBytes(content, testCase.cursorMode, testCase.lines.map((record) => line(record)));
      } else {
        cursor = testCase.cursor || 0;
      }

      const expected = readSessionEvents('codex', { sessionId }, { cursor });
      fixture.cases.push({
        name: testCase.name,
        sessionId,
        records: testCase.lines.map((record) => line(record)),
        tail: testCase.tail || '',
        cursor,
        cursorAfterLines: testCase.cursorAfterLines,
        expected
      });
      fs.removeSync(home);
    }
  } finally {
    if (previousHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = previousHome;
  }
  fs.ensureDirSync(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');
  process.stdout.write('wrote ' + outPath + ' (' + fixture.cases.length + ' cases)\n');
}

main();
