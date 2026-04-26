export function supportsExternalPending(provider) {
  return provider === 'codex';
}

export function supportsSessionWatchPending(provider) {
  return supportsExternalPending(provider);
}

export function supportsBackgroundRunWatch(provider) {
  return supportsExternalPending(provider);
}

export function supportsToolBoundaryQueue(provider, apiKeyMode) {
  return provider === 'codex' && !apiKeyMode;
}

export function resolveQueueMode(provider, apiKeyMode) {
  return supportsToolBoundaryQueue(provider, apiKeyMode) ? 'after_tool_call' : 'after_turn';
}
