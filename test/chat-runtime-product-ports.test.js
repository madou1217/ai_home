'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createUnsupportedArtifactReader
} = require('../lib/server/chat-runtime/unsupported-artifact-reader');

test('unsupported artifact reader fails explicitly instead of pretending an id is missing', async () => {
  const reader = createUnsupportedArtifactReader();

  await assert.rejects(reader.read('artifact-1'), (error) => {
    assert.equal(error.code, 'chat_artifact_unsupported');
    assert.equal(error.statusCode, 501);
    return true;
  });
});
