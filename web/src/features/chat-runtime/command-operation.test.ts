import assert from 'node:assert/strict';
import test from 'node:test';

import { runCommandOperation } from './command-operation';

test('failed queue save keeps the editor transition pending and preserves the error', async () => {
  const failure = new Error('queue edit failed');
  let editorClosed = false;

  const result = await runCommandOperation({
    execute: async () => { throw failure; },
    onSuccess: () => { editorClosed = true; },
  });

  assert.deepEqual(result, { ok: false, error: failure });
  assert.equal(editorClosed, false);
});

test('failed unanswered submission keeps its confirmation until a successful retry', async () => {
  const transitions: string[] = [];
  let attempts = 0;
  const operation = {
    execute: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('answer failed');
    },
    onSuccess: () => { transitions.push('confirmation-cleared'); },
  };

  const failed = await runCommandOperation(operation);
  assert.equal(failed.ok, false);
  assert.deepEqual(transitions, []);

  const succeeded = await runCommandOperation(operation);
  assert.deepEqual(transitions, ['confirmation-cleared']);
  assert.deepEqual(succeeded, { ok: true });
});
