'use strict';

const { ChatRuntimeError } = require('./contracts');

// Provider-neutral orchestration: provider ports produce/verify native receipts;
// the existing SQLite store owns checkpoints. Pending RPCs are never replayed.
async function prepareNativeBranch({ repository, command, plan, native }) {
  let operation = repository.prepare(command, plan);
  const advance = (state, receipt) => {
    operation = repository.advance(command.sessionId, command.commandId, operation.state, state, receipt);
  };
  if (operation.state === 'prepared') {
    advance('fork_pending');
    let receipt;
    try { receipt = await native.fork(operation); }
    catch (_error) { receipt = await native.recoverFork(operation); }
    if (!receipt) throw outcomeUnknown('fork');
    advance('forked', receipt);
  } else if (operation.state === 'fork_pending') {
    const receipt = await native.recoverFork(operation);
    if (!receipt) throw outcomeUnknown('fork');
    advance('forked', receipt);
  }
  if (operation.state === 'forked') {
    if (!operation.plan.items.length) advance('ready');
    else {
      advance('inject_pending');
      try { await native.inject(operation); }
      catch (_error) {
        if (await native.recoverInjection(operation) !== 'complete') throw outcomeUnknown('injection');
      }
      advance('ready');
    }
  } else if (operation.state === 'inject_pending') {
    if (await native.recoverInjection(operation) !== 'complete') throw outcomeUnknown('injection');
    advance('ready');
  }
  return operation;
}

function outcomeUnknown(stage) {
  return new ChatRuntimeError(`chat_branch_${stage}_outcome_unknown`, 409, { retryable: false });
}

module.exports = { prepareNativeBranch };
