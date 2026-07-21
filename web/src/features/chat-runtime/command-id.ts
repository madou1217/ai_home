export function createWebCommandId(scope = 'command'): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === 'function') {
    return `web-${scope}-${randomUuid.call(globalThis.crypto)}`;
  }
  const random = Math.random().toString(36).slice(2);
  return `web-${scope}-${Date.now().toString(36)}-${random}`;
}
