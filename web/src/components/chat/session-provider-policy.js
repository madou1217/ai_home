// 共享的是地区内的原生会话；执行账号、凭证和客户端仍按各自 provider 隔离。
const SHARED_SESSION_REGIONS = Object.freeze({
  codebuddy: 'global',
  workbuddy: 'global',
  codebuddycn: 'cn',
  workbuddycn: 'cn',
});

export function areNativeSessionProvidersCompatible(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const region = SHARED_SESSION_REGIONS[left];
  return Boolean(region && region === SHARED_SESSION_REGIONS[right]);
}

export function isSharedNativeSession(session) {
  return Boolean(session && !session.draft && session.mode !== 'chat'
    && session.projectPath && !session.runtimeSessionId && !session.accountRef
    && SHARED_SESSION_REGIONS[session.provider]);
}

export function isSessionAccountProviderCompatible(session, provider) {
  return Boolean(session && (session.provider === provider
    || (isSharedNativeSession(session)
      && areNativeSessionProvidersCompatible(session.provider, provider))));
}
