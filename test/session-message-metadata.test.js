const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decorateMessagesWithRecordedTurnModels,
  decorateMessagesWithTurnModels
} = require('../lib/sessions/session-message-metadata');

test('decorateMessagesWithTurnModels associates model metadata with the complete turn', () => {
  const source = [
    { role: 'user', content: 'first', timestamp: 1 },
    { role: 'assistant', content: 'thinking', timestamp: 2, model: 'gpt-5.6-sol' },
    { role: 'assistant', content: 'done', timestamp: 3 },
    { role: 'user', content: 'second', timestamp: 4, model: 'opencode-go/glm-5.2' },
    { role: 'assistant', content: 'done again', timestamp: 5 },
    { role: 'user', content: 'unknown', timestamp: 6 },
    { role: 'assistant', content: 'unknown reply', timestamp: 7 },
    { role: 'user', content: 'synthetic turn', timestamp: 8 },
    { role: 'assistant', content: 'synthetic reply', timestamp: 9, model: '<synthetic>' }
  ];

  const decorated = decorateMessagesWithTurnModels(source);

  assert.deepEqual(decorated.map((message) => message.model || ''), [
    'gpt-5.6-sol',
    'gpt-5.6-sol',
    'gpt-5.6-sol',
    'opencode-go/glm-5.2',
    'opencode-go/glm-5.2',
    '',
    '',
    '',
    ''
  ]);
  assert.equal(source[0].model, undefined, 'canonical decoration must not mutate provider parser output');
});

test('decorateMessagesWithRecordedTurnModels overrides stale AGY labels per completed turn', () => {
  const source = [
    { role: 'user', content: 'first', timestamp: '2026-07-21T09:04:26Z', model: 'Gemini 3.5 Flash (Medium)' },
    { role: 'assistant', content: 'first reply', timestamp: '2026-07-21T09:04:27Z', model: 'Gemini 3.5 Flash (Medium)' },
    { role: 'user', content: 'second', timestamp: '2026-07-21T09:10:30Z', model: 'Gemini 3.5 Flash (Medium)' },
    { role: 'assistant', content: 'second reply', timestamp: '2026-07-21T09:10:31Z', model: 'Gemini 3.5 Flash (Medium)' },
    { role: 'user', content: 'pending transcript-only turn', timestamp: '2026-07-21T09:40:00Z', model: 'Gemini 3.5 Flash (Medium)' }
  ];
  const records = [
    { model: 'gemini-3.6-flash-tiered', timestampMs: Date.parse('2026-07-21T09:05:53Z') },
    { model: 'gemini-3.6-flash-tiered', timestampMs: Date.parse('2026-07-21T09:11:09Z') }
  ];

  const decorated = decorateMessagesWithRecordedTurnModels(source, records);

  assert.deepEqual(decorated.map((message) => message.model), [
    'gemini-3.6-flash-tiered',
    'gemini-3.6-flash-tiered',
    'gemini-3.6-flash-tiered',
    'gemini-3.6-flash-tiered',
    'Gemini 3.5 Flash (Medium)'
  ]);
  assert.equal(source[0].model, 'Gemini 3.5 Flash (Medium)');
});
