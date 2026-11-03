import type { ChatMessage, SessionMessageBundle } from '@/types';

type HistoryPageQuery = { before?: number };
type HistoryPageLoader = (query: HistoryPageQuery) => Promise<SessionMessageBundle>;

export function getSessionHistoryWindowEnd(window: SessionMessageBundle): number;
export function rebaseOlderSessionHistoryPage(
  latestWindow: SessionMessageBundle | null | undefined,
  olderPage: SessionMessageBundle,
): SessionMessageBundle;
export function rebaseLatestSessionHistoryTail(
  latestWindow: SessionMessageBundle | null | undefined,
  refreshedTail: SessionMessageBundle,
): SessionMessageBundle;
export function advanceSessionHistoryWindow(
  latestWindow: SessionMessageBundle | null | undefined,
  messages: ChatMessage[],
  cursor: number,
): SessionMessageBundle | null;
export function isSessionHistorySnapshotCurrent(
  observedCursor: number,
  snapshotWindow: SessionMessageBundle,
): boolean;
export function didSessionHistoryCursorReset(previousCursor: number, nextCursor: number): boolean;
export function didSessionHistorySnapshotReset(
  latestWindow: SessionMessageBundle | null | undefined,
  snapshotWindow: SessionMessageBundle | null | undefined,
  observedCursor: number,
): boolean;
export function collectAllSessionHistoryMessages(loader: HistoryPageLoader): Promise<ChatMessage[]>;
export function loadContiguousSessionHistoryTail(
  currentWindow: SessionMessageBundle | null | undefined,
  loader: HistoryPageLoader,
): Promise<SessionMessageBundle>;
