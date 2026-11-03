import { optionalText, protocolFailure, record } from './dto-guards';
import type { RuntimeBinding } from './types';

export function parseRuntimeBinding(value: unknown): RuntimeBinding {
  const source = record(value, 'chat_runtime_binding_invalid');
  const provider = optionalText(source.provider, 'chat_runtime_binding_provider_invalid');
  const runtimeId = optionalText(source.runtimeId, 'chat_runtime_binding_runtime_id_invalid');
  const nativeSessionId = optionalText(
    source.nativeSessionId,
    'chat_runtime_binding_native_session_id_invalid',
  );
  const fingerprint = optionalText(
    source.fingerprint,
    'chat_runtime_binding_fingerprint_invalid',
  );
  const version = optionalText(source.version, 'chat_runtime_binding_version_invalid');
  const runtimeGeneration = optionalSafeInteger(source.runtimeGeneration);
  return {
    ...(provider ? { provider } : {}),
    ...(runtimeId ? { runtimeId } : {}),
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(version ? { version } : {}),
    ...(runtimeGeneration === undefined ? {} : { runtimeGeneration }),
  };
}

function optionalSafeInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) protocolFailure('chat_runtime_binding_generation_invalid');
  return Number(value);
}
