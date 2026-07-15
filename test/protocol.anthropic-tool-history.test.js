'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeAnthropicToolHistory,
  sanitizeAnthropicToolHistoryWithStats
} = require('../lib/protocol/anthropic-tool-history');

test('Anthropic tool history sanitizer preserves adjacent generic tool pairs', () => {
  const { messages, stats } = sanitizeAnthropicToolHistoryWithStats([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will call tools.' },
        { type: 'tool_use', id: 'call_fetch_1', name: 'CustomFetch', input: { url: 'https://example.test' } },
        { type: 'tool_use', id: 'call_shell_1', name: 'ShellExec', input: { command: 'pwd' } }
      ]
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_fetch_1', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'call_shell_1', content: 'done' }
      ]
    }
  ]);

  assert.deepEqual(messages.map((message) => message.role), ['assistant', 'user']);
  assert.deepEqual(messages[0].content.map((part) => part.type), ['text', 'tool_use', 'tool_use']);
  assert.deepEqual(messages[1].content.map((part) => part.type), ['tool_result', 'tool_result']);
  assert.deepEqual(stats, {
    droppedUnansweredToolUseCount: 0,
    orphanToolResultCount: 0
  });
});

test('Anthropic tool history sanitizer downgrades non-adjacent tool results without tool-specific rules', () => {
  const { messages, stats } = sanitizeAnthropicToolHistoryWithStats([
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_read_1', name: 'Read', input: { file_path: 'package.json' } },
        { type: 'tool_use', id: 'call_custom_1', name: 'CustomTool', input: { value: 1 } }
      ]
    },
    {
      role: 'user',
      content: 'continue before returning results'
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_read_1', content: 'package content' },
        { type: 'tool_result', tool_use_id: 'call_custom_1', content: { ok: true } }
      ]
    }
  ]);

  assert.deepEqual(messages.map((message) => message.role), ['user', 'user']);
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'continue before returning results' }]);
  assert.deepEqual(messages[1].content, [
    { type: 'text', text: 'Tool result (call_read_1):\npackage content' },
    { type: 'text', text: 'Tool result (call_custom_1):\n{"ok":true}' }
  ]);
  assert.deepEqual(stats, {
    droppedUnansweredToolUseCount: 2,
    orphanToolResultCount: 2
  });
});

test('Anthropic tool history sanitizer drops only unanswered tool uses from partial tool batches', () => {
  const messages = sanitizeAnthropicToolHistory([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'parallel calls' },
        { type: 'tool_use', id: 'call_fetch_1', name: 'CustomFetch', input: { url: 'https://example.test' } },
        { type: 'tool_use', id: 'call_shell_1', name: 'ShellExec', input: { command: 'pwd' } }
      ]
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_fetch_1', content: 'ok' },
        { type: 'text', text: 'shell result is missing' }
      ]
    }
  ]);

  assert.deepEqual(messages.map((message) => message.role), ['assistant', 'user']);
  assert.deepEqual(messages[0].content.map((part) => part.type), ['text', 'tool_use']);
  assert.equal(messages[0].content[1].id, 'call_fetch_1');
  assert.deepEqual(messages[1].content.map((part) => part.type), ['tool_result', 'text']);
  assert.equal(messages[1].content[0].tool_use_id, 'call_fetch_1');
});

test('Anthropic tool history sanitizer can preserve trailing tool uses for provider adapters', () => {
  const { messages, stats } = sanitizeAnthropicToolHistoryWithStats([
    {
      role: 'user',
      content: [{ type: 'text', text: 'Fetch status' }]
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will call the tool.' },
        { type: 'tool_use', id: 'call_fetch_1', name: 'CustomFetch', input: { url: 'https://example.test' } }
      ]
    }
  ], {
    dropTrailingUnansweredToolUses: false
  });

  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
  assert.deepEqual(messages[1].content.map((part) => part.type), ['text', 'tool_use']);
  assert.deepEqual(stats, {
    droppedUnansweredToolUseCount: 0,
    orphanToolResultCount: 0
  });
});
