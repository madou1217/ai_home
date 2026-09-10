import { booleanValue, nonNegativeInteger, optionalText, record, text } from './dto-guards';
import type { FailedTurn } from './types';

export function parseTurnError(value: unknown): FailedTurn['error'] {
  const source = record(value, 'chat_runtime_turn_error_invalid');
  return {
    code: text(source.code, 'chat_runtime_turn_error_code_invalid'),
    ...(source.message === undefined ? {} : {
      message: optionalText(source.message, 'chat_runtime_turn_error_message_invalid'),
    }),
  };
}

export function parseFailedTurn(value: unknown): FailedTurn {
  const source = record(value, 'chat_runtime_failed_turn_invalid');
  return {
    turnId: text(source.turnId, 'chat_runtime_failed_turn_id_invalid'),
    failedAt: nonNegativeInteger(source.failedAt, 'chat_runtime_failed_turn_at_invalid'),
    error: parseTurnError(source.error),
    retryable: booleanValue(source.retryable, 'chat_runtime_failed_turn_retryable_invalid'),
  };
}
