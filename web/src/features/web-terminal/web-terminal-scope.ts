export interface TerminalScope<T> {
  serverId: string;
  state: T;
}

// Async launch/close callbacks belong to the server where they started, even
// if a different server is active by the time they finish.
export function updateTerminalScope<T>(
  current: TerminalScope<T>,
  serverId: string,
  change: (state: T) => T,
  read: (serverId: string) => T,
  persist: (serverId: string, state: T) => void,
): TerminalScope<T> {
  const scoped = current.serverId === serverId ? current.state : read(serverId);
  const next = change(scoped);
  persist(serverId, next);
  return current.serverId === serverId ? { ...current, state: next } : current;
}
