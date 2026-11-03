import type {
  Account,
  AggregatedProject,
} from '@/types';
import { resolveActiveServer } from '@/services/api';

const PROJECTS_CACHE_PREFIX = 'chat-projects-cache:v2:';
const PROJECTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ACCOUNTS_CACHE_PREFIX = 'chat-accounts-cache:v1:';
const ACCOUNTS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type CachedCollection<T> = {
  updatedAt: number;
  items: T[];
};

function activeServerKey(): string {
  try {
    return resolveActiveServer().serverId || 'local';
  } catch {
    return 'local';
  }
}

function readCollection<T>(key: string, property: string, ttlMs: number): T[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null') as Record<string, unknown> | null;
    if (!raw || !Array.isArray(raw[property])) return [];
    if (Date.now() - Number(raw.updatedAt || 0) > ttlMs) return [];
    return raw[property] as T[];
  } catch {
    return [];
  }
}

function writeCollection<T>(key: string, property: string, items: T[]): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: CachedCollection<T> = { updatedAt: Date.now(), items };
    localStorage.setItem(key, JSON.stringify({
      updatedAt: payload.updatedAt,
      [property]: payload.items,
    }));
  } catch {}
}

export function projectHydrationServerKey(): string {
  const server = resolveActiveServer();
  return `${server.serverId || 'local'}:${server.isRemote ? 'remote' : 'same-origin'}`;
}

export function readCachedChatAccounts(): Account[] {
  return readCollection<Account>(
    ACCOUNTS_CACHE_PREFIX + activeServerKey(),
    'accounts',
    ACCOUNTS_CACHE_TTL_MS,
  );
}

export function writeCachedChatAccounts(accounts: Account[]): void {
  const slim = accounts.map((account) => ({ ...account, usageSnapshot: undefined }));
  writeCollection(ACCOUNTS_CACHE_PREFIX + activeServerKey(), 'accounts', slim);
}

export function readCachedProjects(): AggregatedProject[] {
  return readCollection<AggregatedProject>(
    PROJECTS_CACHE_PREFIX + activeServerKey(),
    'projects',
    PROJECTS_CACHE_TTL_MS,
  );
}

export function writeCachedProjects(projects: AggregatedProject[]): void {
  writeCollection(PROJECTS_CACHE_PREFIX + activeServerKey(), 'projects', projects);
  try {
    localStorage.removeItem('chat-projects-cache:v1');
  } catch {}
}
