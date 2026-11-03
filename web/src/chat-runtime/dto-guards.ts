import type { SessionState } from './types';

const SESSION_STATES = new Set<SessionState>([
  'idle', 'starting', 'running', 'waiting_input', 'interrupting',
  'completing', 'recovering', 'closed',
]);

export class ChatRuntimeProtocolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ChatRuntimeProtocolError';
  }
}

export function protocolFailure(code: string): never {
  throw new ChatRuntimeProtocolError(code);
}

export function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) protocolFailure(code);
  return value as Record<string, unknown>;
}

export function records(value: unknown, code: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) protocolFailure(code);
  return value.map((entry) => record(entry, code));
}

export function text(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') protocolFailure(code);
  return value;
}

export function optionalText(value: unknown, code: string): string | undefined {
  return value === undefined ? undefined : text(value, code);
}

export function nonNegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) protocolFailure(code);
  return Number(value);
}

export function positiveInteger(value: unknown, code: string): number {
  const number = nonNegativeInteger(value, code);
  if (number === 0) protocolFailure(code);
  return number;
}

export function booleanValue(value: unknown, code: string): boolean {
  if (typeof value !== 'boolean') protocolFailure(code);
  return value;
}

export function sessionState(value: unknown): SessionState {
  const state = text(value, 'chat_runtime_state_invalid') as SessionState;
  if (!SESSION_STATES.has(state)) protocolFailure('chat_runtime_state_invalid');
  return state;
}

export function assertSessionId(actual: unknown, expected: string): string {
  const sessionId = text(actual, 'chat_runtime_session_id_invalid');
  if (sessionId !== expected) protocolFailure('chat_runtime_session_mismatch');
  return sessionId;
}
