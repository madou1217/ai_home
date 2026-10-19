const test = require('node:test');
const assert = require('node:assert/strict');

const {
  encodeKiroConversation,
  createKiroFrameDecoder,
  MISSING_TOOL_RESULT_TEXT
} = require('../lib/server/kiro-dialect');

const weatherTool = { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } };

function frame(eventType, payload) {
  return { messageType: 'event', eventType, payload: JSON.stringify(payload) };
}

test('tools go into the current message only, with a non-empty description (empty is a 400 upstream)', () => {
  const { conversationState, toolCount } = encodeKiroConversation({
    model: 'claude-opus-5.5',
    messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
    tools: [weatherTool]
  });
  assert.equal(toolCount, 1);
  const spec = conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification;
  assert.equal(spec.name, 'get_weather');
  assert.equal(spec.description, 'get_weather');
  assert.deepEqual(spec.inputSchema.json, weatherTool.function.parameters);
  assert.equal(conversationState.history[0].userInputMessage.userInputMessageContext.tools, undefined);
  assert.equal(conversationState.currentMessage.userInputMessage.modelId, 'claude-opus-5.5');
  assert.equal(conversationState.currentMessage.userInputMessage.origin, 'AI_EDITOR');
});

test('assistant tool_calls become toolUses; tool messages and following user text merge into one turn', () => {
  const { conversationState } = encodeKiroConversation({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'weather in Paris and Oslo' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
          { id: 't2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }
        ]
      },
      { role: 'tool', tool_call_id: 't2', content: 'rain' },
      { role: 'tool', tool_call_id: 't1', content: [{ type: 'text', text: 'sun' }] },
      { role: 'user', content: 'compare them' }
    ],
    tools: [weatherTool]
  });
  assert.equal(conversationState.history[0].userInputMessage.content, 'sys\n\nweather in Paris and Oslo');
  assert.equal(conversationState.history[1].assistantResponseMessage.content, '');
  assert.deepEqual(conversationState.history[1].assistantResponseMessage.toolUses, [
    { toolUseId: 't1', name: 'get_weather', input: { city: 'Paris' } },
    { toolUseId: 't2', name: 'get_weather', input: { city: 'Oslo' } }
  ]);
  const current = conversationState.currentMessage.userInputMessage;
  assert.equal(current.content, 'compare them');
  // 结果按调用顺序重排（上游按位置配对）。
  assert.deepEqual(current.userInputMessageContext.toolResults.map((item) => item.toolUseId), ['t1', 't2']);
  assert.deepEqual(current.userInputMessageContext.toolResults[0].content, [{ text: 'sun' }]);
});

test('orphan tool results degrade to text and missing results are filled with an error result', () => {
  const { conversationState } = encodeKiroConversation({
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 't1', function: { name: 'get_weather', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'ghost', content: 'stale output' },
      { role: 'user', content: 'next' }
    ],
    tools: [weatherTool]
  });
  const current = conversationState.currentMessage.userInputMessage;
  assert.deepEqual(current.userInputMessageContext.toolResults, [
    { toolUseId: 't1', status: 'error', content: [{ text: MISSING_TOOL_RESULT_TEXT }] }
  ]);
  assert.match(current.content, /\[tool result ghost\]\nstale output/);
  assert.match(current.content, /next$/);
});

test('history with tool blocks but no declared tools gets minimal tool specs (else TOOL_CONFIG_MISSING)', () => {
  const { conversationState } = encodeKiroConversation({
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'a.txt' }
    ]
  });
  const context = conversationState.currentMessage.userInputMessage.userInputMessageContext;
  assert.deepEqual(context.tools, [{ toolSpecification: { name: 'Bash', description: 'Bash', inputSchema: { json: { type: 'object', properties: {} } } } }]);
  assert.equal(conversationState.currentMessage.userInputMessage.content, '');
});

test('a trailing assistant tool call is closed with an error result before the continue prompt', () => {
  const { conversationState } = encodeKiroConversation({
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'Bash', arguments: 'not json' } }] }
    ]
  });
  assert.deepEqual(conversationState.history[1].assistantResponseMessage.toolUses[0].input, { input: 'not json' });
  const context = conversationState.currentMessage.userInputMessage.userInputMessageContext;
  assert.equal(context.toolResults[0].toolUseId, 't1');
  assert.equal(context.toolResults[0].status, 'error');
});

test('inline images are sent as kiro image blocks; remote URLs become an explicit placeholder', () => {
  const { conversationState } = encodeKiroConversation({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }
      ]
    }]
  });
  const message = conversationState.currentMessage.userInputMessage;
  assert.deepEqual(message.images, [{ format: 'png', source: { bytes: 'QUJD' } }]);
  assert.match(message.content, /what is this/);
  assert.match(message.content, /远程图片/);
});

test('frame decoder reassembles streamed tool input and reports metering / context usage', () => {
  const decoder = createKiroFrameDecoder();
  const events = [
    frame('initial-response', { conversationId: 'c1' }),
    frame('assistantResponseEvent', { content: 'Let me check.' }),
    frame('toolUseEvent', { name: 'get_weather', toolUseId: 'u1' }),
    frame('toolUseEvent', { input: '', name: 'get_weather', toolUseId: 'u1' }),
    frame('toolUseEvent', { input: '{"ci', name: 'get_weather', toolUseId: 'u1' }),
    frame('toolUseEvent', { input: 'ty":"Paris"}', name: 'get_weather', toolUseId: 'u1' }),
    frame('toolUseEvent', { name: 'get_weather', stop: true, toolUseId: 'u1' }),
    frame('toolUseEvent', { name: 'get_weather', toolUseId: 'u2' }),
    frame('contextUsageEvent', { contextUsagePercentage: 3.5 }),
    frame('meteringEvent', { unit: 'credit', usage: 0.03 })
  ].flatMap((item) => decoder.decode(item)).concat(decoder.flush());
  assert.deepEqual(events.map((event) => event.type), [
    'conversation', 'text',
    'tool_call_start', 'tool_call_delta', 'tool_call_delta', 'tool_call_done',
    'tool_call_start', 'context_usage', 'metering',
    'tool_call_done'
  ]);
  assert.equal(events[5].arguments, '{"city":"Paris"}');
  assert.equal(events[6].index, 1);
  assert.deepEqual(decoder.toolCalls.map((call) => call.id), ['u1', 'u2']);
});
