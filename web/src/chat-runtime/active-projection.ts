import type { ChatRuntimeEvent, PendingInteraction, SessionQueueEntry } from './types';

const ACTIVE_QUEUE_STATES = new Set<SessionQueueEntry['status']>([
  'queued', 'leased', 'running',
]);
const ACTIVE_INTERACTION_STATES = new Set<PendingInteraction['state']>([
  'pending', 'resolving',
]);

export function activeQueue(entries: readonly SessionQueueEntry[]): readonly SessionQueueEntry[] {
  return entries.filter((entry) => ACTIVE_QUEUE_STATES.has(entry.status));
}

export function projectQueueEvent(
  entries: readonly SessionQueueEntry[],
  event: ChatRuntimeEvent,
): readonly SessionQueueEntry[] | undefined {
  switch (event.type) {
    case 'queue.item.added':
    case 'queue.item.updated':
    case 'queue.item.dispatched':
      return upsertQueue(entries, event.payload.entry);
    case 'queue.item.removed':
      return removeQueue(entries, event.payload.queueId);
    case 'queue.item.moved':
      return moveQueue(entries, event.payload.queueId, event.payload.beforeQueueId);
    default:
      return undefined;
  }
}

export function activeInteractions(
  entries: readonly PendingInteraction[],
): readonly PendingInteraction[] {
  return entries.filter((entry) => ACTIVE_INTERACTION_STATES.has(entry.state));
}

export function projectInteractionEvent(
  entries: readonly PendingInteraction[],
  event: ChatRuntimeEvent,
): readonly PendingInteraction[] | undefined {
  switch (event.type) {
    case 'interaction.requested':
    case 'interaction.updated':
      return ACTIVE_INTERACTION_STATES.has(event.payload.interaction.state)
        ? upsertInteraction(entries, event.payload.interaction)
        : removeInteraction(entries, event.payload.interaction.interactionId);
    case 'interaction.resolved':
    case 'interaction.expired':
      return removeInteraction(entries, event.payload.interaction.interactionId);
    default:
      return undefined;
  }
}

function upsertQueue(
  entries: readonly SessionQueueEntry[], entry: SessionQueueEntry,
): readonly SessionQueueEntry[] {
  if (!ACTIVE_QUEUE_STATES.has(entry.status)) return removeQueue(entries, entry.queueId);
  const found = entries.some(({ queueId }) => queueId === entry.queueId);
  const next = found
    ? entries.map((current) => current.queueId === entry.queueId ? entry : current)
    : [...entries, entry];
  return [...next].sort((left, right) => left.position - right.position);
}

function removeQueue(entries: readonly SessionQueueEntry[], queueId: string) {
  return entries.filter((entry) => entry.queueId !== queueId);
}

function moveQueue(
  entries: readonly SessionQueueEntry[], queueId: string, beforeQueueId?: string,
): readonly SessionQueueEntry[] {
  const moving = entries.find((entry) => entry.queueId === queueId);
  if (!moving) return entries;
  const remaining = entries.filter((entry) => entry.queueId !== queueId);
  const target = beforeQueueId
    ? remaining.findIndex((entry) => entry.queueId === beforeQueueId)
    : remaining.length;
  const insertion = target < 0 ? remaining.length : target;
  return [...remaining.slice(0, insertion), moving, ...remaining.slice(insertion)]
    .map((entry, position) => ({ ...entry, position }));
}

function upsertInteraction(
  entries: readonly PendingInteraction[], interaction: PendingInteraction,
): readonly PendingInteraction[] {
  const found = entries.some(({ interactionId }) => interactionId === interaction.interactionId);
  return found
    ? entries.map((current) => (
        current.interactionId === interaction.interactionId ? interaction : current
      ))
    : [...entries, interaction];
}

function removeInteraction(entries: readonly PendingInteraction[], interactionId: string) {
  return entries.filter((entry) => entry.interactionId !== interactionId);
}
