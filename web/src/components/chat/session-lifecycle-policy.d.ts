import type {
  ArchivedSession,
  Provider,
  ProviderSessionLifecycleCapability
} from '@/types';

export interface ArchiveActionState {
  visible: boolean;
  disabled: boolean;
  reason: string;
}

export function resolveArchiveAction(
  capabilities: Partial<Record<Provider, ProviderSessionLifecycleCapability>> | null | undefined,
  provider: Provider | string | null | undefined
): ArchiveActionState;

export function canUnarchiveSession(session: Partial<ArchivedSession> | null | undefined): boolean;
export function archivedSessionTime(session: Partial<ArchivedSession> | null | undefined): number;
