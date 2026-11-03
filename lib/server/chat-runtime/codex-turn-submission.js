'use strict';

const { ChatRuntimeError } = require('./contracts');

// Codex persists clientUserMessageId on the user item. Like DSH consumed-work,
// recover from the execution record, never infer rejection from a lost receipt.
async function submitCodexTurn({ client, active, params, anchor }) {
  let result;
  try {
    result = await client.request('turn/start', params);
  } catch (error) {
    if (error?.code !== 'codex_app_server_disconnected') throw error;
    active.submissionUncertain = true;
    if (typeof client.waitForReconnect !== 'function' || !await client.waitForReconnect()) {
      throw uncertainSubmissionError(error);
    }
    // The binding recovery hook imports history and persists the exact anchor.
    // onDisconnected settles a failed recovery; neither path resubmits input.
    if (active.settled) return;
    if (!active.persistedNativeTurnId) throw uncertainSubmissionError(error);
    return;
  }
  const nativeTurnId = String(result?.turn?.id || '').trim();
  if (!nativeTurnId) throw new ChatRuntimeError('codex_native_turn_missing', 502);
  await anchor(active, nativeTurnId);
}

function uncertainSubmissionError(cause) {
  const error = new ChatRuntimeError('codex_turn_start_outcome_unknown', 502);
  error.message = '启动回执丢失，尚未确认原回合的执行结果；请先核对实际结果。';
  error.outcomeUnknown = true;
  error.cause = cause;
  return error;
}

module.exports = { submitCodexTurn, uncertainSubmissionError };
