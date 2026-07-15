import type { Provider } from '@/types';

export interface ProviderCatalogEntry {
  id: Provider;
  label: string;
  short: string;
  terminalIcon: string;
  terminalIconAsset: string;
  accentVar: string;
  softVar: string;
  tagColor: string;
}

export const PROVIDER_CATALOG: Record<Provider, ProviderCatalogEntry>;
export const CATALOG_FALLBACK: ProviderCatalogEntry;
export const providerIds: Provider[];
export const providerNames: Record<Provider, string>;
export function getProviderLabel(provider: Provider | string | undefined | null): string;
export function getProviderTagColor(provider: Provider | string | undefined | null): string;
export function getProviderTerminalIcon(provider: Provider | string | undefined | null): string;
export function getProviderTerminalIconAsset(provider: Provider | string | undefined | null): string;
export function getProviderTerminalBadge(provider: Provider | string | undefined | null): string;
