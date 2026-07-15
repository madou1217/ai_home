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

// mid-run 插话(真 steer):运行中把新消息注入当前 run。claude native 的 stream-json stdin
// 已实证支持(同会话下一轮排队语义);codex 的 turn/steer 走 app-server(P3 接入后放开)。
export function supportsMidRunSteer(provider, apiKeyMode) {
  return provider === 'claude' && !apiKeyMode;
}
