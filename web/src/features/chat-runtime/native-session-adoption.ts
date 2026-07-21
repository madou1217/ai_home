import type { ChatRuntimeSession } from '@/chat-runtime';
import type { Session } from '@/types';

interface AdoptionContext {
  readonly session: Session;
  readonly projectPath?: string;
}

export interface ResolvedSessionAdoption {
  readonly nativeSessionId: string;
  readonly session: Session | null;
}

export function adoptDraftNativeSession(
  context: AdoptionContext,
  nativeSessionId: string,
  now: number = Date.now(),
): Session | null {
  const nativeId = normalizedText(nativeSessionId);
  if (!context.session.draft || !nativeId) return null;
  return {
    ...context.session,
    id: nativeId,
    draft: false,
    updatedAt: now,
    projectPath: adoptionProjectPath(context),
  };
}

export function createFreshNativeSession(
  context: AdoptionContext,
  nativeSessionId: string,
  now: number = Date.now(),
): Session | null {
  const nativeId = normalizedText(nativeSessionId);
  if (!nativeId) return null;
  return {
    id: nativeId,
    title: '新会话',
    updatedAt: now,
    provider: context.session.provider,
    projectPath: adoptionProjectPath(context),
    ...(context.session.projectDirName
      ? { projectDirName: context.session.projectDirName }
      : {}),
    draft: false,
  };
}

export function resolveNativeSessionAdoption(
  current: Session,
  resolved: ChatRuntimeSession,
  fallbackProjectPath?: string,
): ResolvedSessionAdoption | null {
  if (resolved.provider !== current.provider) return null;
  const nativeSessionId = resolveBoundNativeSessionId(current, resolved.runtimeBinding);
  if (!nativeSessionId) return null;
  const unchanged = current.id === nativeSessionId && current.draft === false;
  return {
    nativeSessionId,
    session: unchanged ? null : {
      ...current,
      id: nativeSessionId,
      draft: false,
      updatedAt: Math.max(current.updatedAt, resolved.updatedAt),
      projectPath: resolved.projectPath || current.projectPath || fallbackProjectPath,
    },
  };
}

export function resolveBoundNativeSessionId(
  session: Session,
  runtimeBinding: Readonly<Record<string, unknown>>,
): string {
  const bound = typeof runtimeBinding.nativeSessionId === 'string'
    ? runtimeBinding.nativeSessionId.trim()
    : '';
  if (session.draft) return bound;
  if (bound && bound !== session.id) {
    throw new Error('chat_runtime_native_session_mismatch');
  }
  return session.id.trim();
}

function adoptionProjectPath(context: AdoptionContext): string | undefined {
  return context.session.projectPath || context.projectPath;
}

function normalizedText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}
