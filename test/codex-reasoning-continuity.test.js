'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeCodexResponsesInput } = require('../lib/server/codex-adapter').__private;

test('sanitizeCodexResponsesInput preserves reasoning summary and converts reasoning into helpful context without breaking decryption', () => {
  const input = [
    {
      type: 'reasoning',
      id: 'rs_RPTJovRIq2yOmXew',
      encrypted_content: 'incompatible_key_blob',
      summary: [{ type: 'summary_text', text: 'Step 1: Analyzed poetry meter.' }]
    },
    {
      type: 'message',
      id: 'msg_123456',
      content: [{ type: 'input_text', text: '接下来请继续' }]
    }
  ];

  const sanitized = sanitizeCodexResponsesInput(input);
  assert.equal(sanitized[0].type, 'reasoning');
  assert.equal(sanitized[0].encrypted_content, undefined);
  assert.equal(sanitized[0].summary[0].text, 'Step 1: Analyzed poetry meter.');
});
