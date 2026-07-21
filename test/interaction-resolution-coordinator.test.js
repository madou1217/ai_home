'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  InteractionResolutionCoordinator
} = require('../lib/server/chat-runtime/interaction-resolution-coordinator');

test('interaction resolution awaits an asynchronous provider effect before finishing', async () => {
  const provider = deferred();
  const calls = [];
  const claimed = { interactionId: 'approval-1', revision: 1 };
  const answered = { ...claimed, state: 'answered' };
  const coordinator = new InteractionResolutionCoordinator({
    claim(interactionId, input) {
      calls.push(['claim', interactionId, input]);
      return claimed;
    },
    finish(interaction) {
      calls.push(['finish', interaction]);
      return answered;
    },
    release() {
      calls.push(['release']);
    }
  });

  const resolution = coordinator.resolve(
    'approval-1',
    { revision: 1, resolution: { decision: 'allow' } },
    async (interaction) => {
      calls.push(['effect', interaction]);
      return provider.promise;
    }
  );

  assert.deepEqual(calls.map(([name]) => name), ['claim', 'effect']);
  provider.resolve({ responded: true });
  assert.deepEqual(await resolution, {
    interaction: answered,
    response: { responded: true }
  });
  assert.deepEqual(calls.map(([name]) => name), ['claim', 'effect', 'finish']);
});

test('interaction resolution releases its claim when an asynchronous provider effect rejects', async () => {
  const failure = new Error('provider response failed');
  const calls = [];
  const claimed = { interactionId: 'approval-1', revision: 1 };
  const coordinator = new InteractionResolutionCoordinator({
    claim() {
      calls.push('claim');
      return claimed;
    },
    finish() {
      calls.push('finish');
    },
    release(interaction) {
      calls.push(['release', interaction]);
    }
  });

  await assert.rejects(
    coordinator.resolve('approval-1', { revision: 1 }, async () => {
      calls.push('effect');
      throw failure;
    }),
    (error) => error === failure
  );

  assert.deepEqual(calls, ['claim', 'effect', ['release', claimed]]);
});

test('interaction resolution preserves the provider error when releasing the claim fails', async () => {
  const providerFailure = new Error('provider response failed');
  const releaseFailure = new Error('release failed');
  const diagnostics = [];
  const coordinator = new InteractionResolutionCoordinator({
    claim: () => ({ interactionId: 'approval-1', revision: 1 }),
    finish() {},
    release() { throw releaseFailure; }
  }, {
    releaseFailureSink: (diagnostic) => diagnostics.push(diagnostic)
  });

  await assert.rejects(
    coordinator.resolve('approval-1', { revision: 1 }, async () => {
      throw providerFailure;
    }),
    (error) => error === providerFailure
  );
  assert.deepEqual(diagnostics, [{
    code: 'chat_interaction_release_failed',
    interactionId: 'approval-1',
    revision: 1
  }]);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}
