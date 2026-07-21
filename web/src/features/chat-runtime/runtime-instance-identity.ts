import type { Session } from '@/types';

export interface RuntimeInstanceIdentity {
  readonly key: string;
  readonly observedSessionId: string;
  readonly pendingNativeSessionId?: string;
}

export function createRuntimeInstanceIdentity(session: Session): RuntimeInstanceIdentity {
  return {
    key: [session.provider, session.draft ? 'draft' : 'native', session.id].join('\u0000'),
    observedSessionId: session.id,
  };
}

export function expectNativeSessionAdoption(
  identity: RuntimeInstanceIdentity,
  nativeSessionId: string,
): RuntimeInstanceIdentity {
  return { ...identity, pendingNativeSessionId: nativeSessionId };
}

export function reconcileRuntimeInstanceIdentity(
  identity: RuntimeInstanceIdentity,
  session: Session,
): RuntimeInstanceIdentity {
  if (session.id === identity.observedSessionId) return identity;
  if (session.id !== identity.pendingNativeSessionId) return createRuntimeInstanceIdentity(session);
  return {
    key: identity.key,
    observedSessionId: session.id,
  };
}
