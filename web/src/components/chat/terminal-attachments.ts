/** Only release borrowed native clients; the provider process is independent. */
export function releaseOrphanedNativeAttachment(
  result: { ok: boolean; termId?: string },
  sessionKey: string,
  reusedByCurrentInstance: boolean,
  close: (termId: string, sessionKey: string) => Promise<unknown>,
) {
  if (result.ok && result.termId && sessionKey.startsWith('native:') && !reusedByCurrentInstance) {
    void close(result.termId, sessionKey).catch(() => {});
  }
}
