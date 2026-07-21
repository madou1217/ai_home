import type { ChatMessage, Session, SessionMessageBundle } from '@/types';

export function legacySessionCacheKey(session: Session): string {
  return `${session.provider}:${session.id}:${session.projectDirName || ''}`;
}

export function legacySessionEffectKey(session: Session | null): string {
  if (!session) return '';
  return `${legacySessionCacheKey(session)}:${session.draft ? 'draft' : 'saved'}`;
}

export function isSameLegacySession(
  left: Session | null | undefined,
  right: Session | null | undefined,
): boolean {
  return Boolean(left && right && legacySessionCacheKey(left) === legacySessionCacheKey(right));
}

export class LegacySessionHistoryState {
  private readonly messagesBySession = new Map<string, ChatMessage[]>();
  private readonly windowBySession = new Map<string, SessionMessageBundle>();
  private readonly cursorBySession = new Map<string, number>();
  private readonly olderPageLoads = new Set<string>();

  readMessages(session: Session): ChatMessage[] | undefined {
    return this.messagesBySession.get(legacySessionCacheKey(session));
  }

  writeMessages(session: Session, messages: ChatMessage[]): void {
    this.messagesBySession.set(legacySessionCacheKey(session), messages);
  }

  readWindow(session: Session): SessionMessageBundle | undefined {
    return this.windowBySession.get(legacySessionCacheKey(session));
  }

  writeWindow(session: Session, window: SessionMessageBundle): void {
    this.windowBySession.set(legacySessionCacheKey(session), window);
  }

  readCursor(session: Session): number {
    return this.cursorBySession.get(legacySessionCacheKey(session)) || 0;
  }

  writeCursor(session: Session, cursor: number): void {
    this.cursorBySession.set(legacySessionCacheKey(session), cursor);
  }

  resetSnapshot(session: Session): void {
    const cacheKey = legacySessionCacheKey(session);
    this.messagesBySession.delete(cacheKey);
    this.windowBySession.delete(cacheKey);
  }

  beginOlderPageLoad(session: Session): boolean {
    const cacheKey = legacySessionCacheKey(session);
    if (this.olderPageLoads.has(cacheKey)) return false;
    this.olderPageLoads.add(cacheKey);
    return true;
  }

  finishOlderPageLoad(session: Session): void {
    this.olderPageLoads.delete(legacySessionCacheKey(session));
  }
}
