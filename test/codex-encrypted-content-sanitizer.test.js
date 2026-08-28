'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeCodexResponsesInput } = require('../lib/server/codex-adapter').__private;

test('sanitizeCodexResponsesInput strips encrypted_content when stripEncryptedContent is true', () => {
  const input = [
    {
      type: 'reasoning',
      id: 'rs_RPTJovRIq2yOmXew',
      encrypted_content: 'some_encrypted_blob_from_another_account',
      summary: [{ type: 'summary_text', text: 'thinking...' }]
    },
    {
      type: 'message',
      id: 'msg_123456',
      content: [{ type: 'input_text', text: 'hello' }]
    }
  ];

  const sanitized = sanitizeCodexResponsesInput(input, { stripEncryptedContent: true });
  assert.equal(sanitized[0].type, 'reasoning');
  assert.equal(sanitized[0].encrypted_content, undefined);
  assert.deepEqual(sanitized[0].summary, [{ type: 'summary_text', text: 'thinking...' }]);
  assert.equal(sanitized[1].id, 'msg_123456');
});
