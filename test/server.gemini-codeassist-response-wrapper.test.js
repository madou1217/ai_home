'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  convertGeminiGenerateContentResponseToAnthropicMessage,
  convertGeminiGenerateContentResponseToOpenAIChatCompletion,
  readGeminiResponseParts
} = require('../lib/server/protocol-gemini-response-adapters');
const { createSseTransformStream } = require('../lib/server/protocol-stream-pipeline');

// cloudcode-pa(agy/antigravity) 的 generateContent / streamGenerateContent 把候选与用量包在
// { response: { candidates, usageMetadata } } 里，而公有 Gemini API 直接平铺。两种形状都必须认，
// 否则 agy 经由 gemini code-assist 路径回来的响应被读成空 → 0 token（claude-* 别名落到 agy 时尤甚）。
function wrappedResponse() {
  return {
    response: {
      candidates: [{
        content: {
          role: 'model',
          parts: [
            { thought: true, text: 'reasoning about the sum' },
            { thoughtSignature: 'sig-abc', text: '4' }
          ]
        },
        finishReason: 'STOP'
      }],
      usageMetadata: {
        promptTokenCount: 13,
        candidatesTokenCount: 1,
        totalTokenCount: 66,
        thoughtsTokenCount: 52
      }
    },
    modelVersion: 'gemini-3-flash-preview'
  };
}

test('reads candidate parts from cloudcode-pa { response: { candidates } } wrapper', () => {
  const parts = readGeminiResponseParts(wrappedResponse());
  // 关键回归点：包在 response 里的候选必须被读到（修复前这里是空 → 0 token）。
  assert.ok(parts.length >= 1, 'wrapped candidates must be read');
  assert.ok(
    parts.some((part) => part && part.type === 'text' && part.text === '4'),
    'the final answer text "4" must be extracted from the wrapped response'
  );
});

test('non-stream gemini->anthropic extracts text + usage from the response wrapper', () => {
  const message = convertGeminiGenerateContentResponseToAnthropicMessage(wrappedResponse(), 'fallback-model');
  const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  assert.match(text, /4/, 'final answer text must survive the wrapper (not an empty 0-token block)');
  assert.equal(message.stop_reason, 'end_turn');
  assert.equal(message.usage.input_tokens, 13, 'usage must be read from response.usageMetadata');
  assert.equal(message.usage.output_tokens, 1);
});

test('non-stream gemini->openai chat extracts text from the response wrapper', () => {
  const chat = convertGeminiGenerateContentResponseToOpenAIChatCompletion(wrappedResponse(), 'fallback-model');
  assert.match(chat.choices[0].message.content, /4/);
  assert.equal(chat.usage.prompt_tokens, 13);
});

test('flat (public Gemini API) shape still works without the wrapper', () => {
  const flat = {
    candidates: [{ content: { parts: [{ text: '4' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
    modelVersion: 'gemini-3-flash-preview'
  };
  const message = convertGeminiGenerateContentResponseToAnthropicMessage(flat, 'fallback-model');
  const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  assert.equal(text, '4');
  assert.equal(message.usage.input_tokens, 5);
});

test('streaming gemini->anthropic SSE emits text + thinking from the response wrapper', () => {
  const out = [];
  const stream = createSseTransformStream('gemini_stream_generate_content', 'anthropic_messages', {
    onChunk: (chunk) => out.push(String(chunk))
  });

  const chunk = {
    response: {
      candidates: [{
        content: {
          role: 'model',
          parts: [
            { thought: true, text: 'thinking...' },
            { thoughtSignature: 'sig', text: '4' }
          ]
        },
        finishReason: 'STOP'
      }],
      usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 1 }
    }
  };
  stream.write(`data: ${JSON.stringify(chunk)}\n\n`);
  stream.end();

  const joined = out.join('');
  // 流式分片的候选同样包在 response 里；修复前 anthropic 流全程空。
  assert.match(joined, /"text":"4"/, 'streamed answer text must survive the wrapper');
  assert.match(joined, /thinking/, 'thought part must stream as a thinking delta (not merged into text)');
});

test('streaming gemini->anthropic SSE normalizes Agent message input', () => {
  const out = [];
  const stream = createSseTransformStream('gemini_stream_generate_content', 'anthropic_messages', {
    onChunk: (chunk) => out.push(String(chunk))
  });

  const chunk = {
    response: {
      candidates: [{
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call_agent_1',
              name: 'Agent',
              args: {
                subagent_type: 'Explore',
                args: [],
                message: 'Please search the web/src folder for chat session persistence issues.'
              }
            }
          }]
        },
        finishReason: 'STOP'
      }]
    }
  };
  stream.write(`data: ${JSON.stringify(chunk)}\n\n`);
  stream.end();

  const joined = out.join('');
  assert.match(joined, /\\"prompt\\":\\"Please search the web\/src folder/);
  assert.match(joined, /\\"description\\":\\"Please search the web\/src folder/);
  assert.doesNotMatch(joined, /\\"message\\"/);
  assert.doesNotMatch(joined, /\\"args\\"/);
});
