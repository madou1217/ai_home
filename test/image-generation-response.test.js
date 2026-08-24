'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readImageGenerationResponseText } = require('../lib/server/image-generation-response');
const { ImageGenerationError } = require('../lib/server/image-generation-strategy');

function responseWithReader(reader) {
  return {
    headers: { get: () => null },
    body: {
      getReader() {
        return reader;
      }
    }
  };
}

test('image response reader wraps a response stream failure as a retryable upstream error', async () => {
  let cancelled = false;
  const response = responseWithReader({
    async read() {
      throw new Error('socket closed while reading');
    },
    async cancel() {
      cancelled = true;
    },
    releaseLock() {}
  });

  await assert.rejects(
    readImageGenerationResponseText(response, { imageGenResponseReadTimeoutMs: 100 }),
    (error) => {
      assert.ok(error instanceof ImageGenerationError);
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, 'upstream_failed');
      assert.match(error.detail, /socket closed while reading/);
      return true;
    }
  );
  assert.equal(cancelled, true);
});

test('image response reader cancels a response stream that exceeds its read deadline', async () => {
  let cancelled = false;
  const response = responseWithReader({
    read() {
      return new Promise(() => {});
    },
    async cancel() {
      cancelled = true;
    },
    releaseLock() {}
  });

  const outcome = await Promise.race([
    readImageGenerationResponseText(response, { imageGenResponseReadTimeoutMs: 10 })
      .then(() => ({ kind: 'resolved' }))
      .catch((error) => ({ kind: 'rejected', error })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'test_timeout' }), 80))
  ]);

  assert.equal(outcome.kind, 'rejected', 'response reader ignored its configured deadline');
  assert.ok(outcome.error instanceof ImageGenerationError);
  assert.equal(outcome.error.statusCode, 502);
  assert.equal(outcome.error.code, 'upstream_failed');
  assert.match(outcome.error.detail, /timed out/);
  assert.equal(cancelled, true);
});
