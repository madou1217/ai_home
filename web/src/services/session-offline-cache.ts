import type { ChatMessage, Session } from '@/types';

/**
 * 会话数据离线缓存（PWA 离线可读的最小闭环）。
 *
 * 存储选型：仓库没有 IndexedDB 封装，项目既有惯例（features/legacy-chat/chat-cache.ts）
 * 是 localStorage + 版本号前缀 + TTL；会话消息按「每会话保留尾部 N 条 + 条数上限 +
 * 配额失败逐条淘汰」三重守卫控制容量，因此沿用 localStorage，不引入新依赖。
 *
 * 数据流：加载成功后 writeCached* 写入；加载失败且内存无旧数据时 readCached* 回退。
 */

export const SESSION_OFFLINE_CACHE_VERSION = 'v1';
/** 目录条目上限：不同项目集合/焦点各一条，超出按写入时间淘汰最旧。 */
export const SESSION_OFFLINE_DIRECTORY_ENTRY_LIMIT = 8;
/** 单份目录缓存最多保留的会话条数（取最新的一段）。 */
export const SESSION_OFFLINE_DIRECTORY_SESSION_LIMIT = 300;
/** 消息缓存的会话条数上限，超出按写入时间淘汰最旧会话。 */
export const SESSION_OFFLINE_MESSAGE_ENTRY_LIMIT = 30;
/** 每个会话只缓存尾部 N 条消息，限制单条目的体积。 */
export const SESSION_OFFLINE_MESSAGES_PER_SESSION_LIMIT = 200;
/** setItem 配额失败时最多淘汰重试次数。 */
const QUOTA_RETRY_LIMIT = 2;

export interface SessionOfflineCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type CacheKind = 'directory' | 'messages';

interface CacheIndexEntry {
  readonly key: string;
  readonly kind: CacheKind;
  readonly updatedAt: number;
}

interface CachePayload<T> {
  readonly version: string;
  readonly updatedAt: number;
  readonly items: readonly T[];
}

const CACHE_PREFIX = `aih-session-offline:${SESSION_OFFLINE_CACHE_VERSION}`;

// 单调时间戳：同一毫秒内的连续写入也必须保持严格的新旧顺序，否则淘汰会误删新条目。
let lastCacheTimestamp = 0;

function nextCacheTimestamp(): number {
  const now = Date.now();
  lastCacheTimestamp = now > lastCacheTimestamp ? now : lastCacheTimestamp + 1;
  return lastCacheTimestamp;
}

function indexStorageKey(scope: string): string {
  return `${CACHE_PREFIX}:index:${scope}`;
}

function directoryStorageKey(scope: string, requestKey: string): string {
  return `${CACHE_PREFIX}:directory:${scope}:${hashSessionOfflineCacheKey(requestKey)}`;
}

function messageStorageKey(scope: string, session: OfflineCacheSessionRef): string {
  const identity = `${session.provider}:${session.id}:${session.projectDirName || ''}`;
  return `${CACHE_PREFIX}:messages:${scope}:${encodeURIComponent(identity)}`;
}

/** djb2 哈希：把可能很长的目录请求 key 收敛成定长标识，纯函数便于测试。 */
export function hashSessionOfflineCacheKey(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function resolveStorage(storage?: SessionOfflineCacheStorage): SessionOfflineCacheStorage | null {
  if (storage) return storage;
  try {
    const candidate = (globalThis as { localStorage?: SessionOfflineCacheStorage }).localStorage;
    return candidate || null;
  } catch {
    return null;
  }
}

function readIndex(storage: SessionOfflineCacheStorage, scope: string): CacheIndexEntry[] {
  try {
    const raw = JSON.parse(storage.getItem(indexStorageKey(scope)) || 'null') as {
      version?: string;
      entries?: CacheIndexEntry[];
    } | null;
    if (!raw || raw.version !== SESSION_OFFLINE_CACHE_VERSION || !Array.isArray(raw.entries)) {
      return [];
    }
    return raw.entries.filter((entry) => entry && typeof entry.key === 'string');
  } catch {
    return [];
  }
}

function writeIndex(
  storage: SessionOfflineCacheStorage,
  scope: string,
  entries: CacheIndexEntry[],
): void {
  try {
    storage.setItem(indexStorageKey(scope), JSON.stringify({
      version: SESSION_OFFLINE_CACHE_VERSION,
      entries,
    }));
  } catch {
    // 索引写入失败只影响淘汰精度，不影响本次缓存内容。
  }
}

function kindEntryLimit(kind: CacheKind): number {
  return kind === 'directory'
    ? SESSION_OFFLINE_DIRECTORY_ENTRY_LIMIT
    : SESSION_OFFLINE_MESSAGE_ENTRY_LIMIT;
}

/** 更新索引并按条目类型截断：同类型超出上限时淘汰写入时间最旧的条目。 */
function recordEntry(
  storage: SessionOfflineCacheStorage,
  scope: string,
  kind: CacheKind,
  key: string,
): void {
  const entries = readIndex(storage, scope)
    .filter((entry) => entry.key !== key);
  entries.push({ key, kind, updatedAt: nextCacheTimestamp() });
  entries.sort((left, right) => right.updatedAt - left.updatedAt);
  const limit = kindEntryLimit(kind);
  let kept = 0;
  const survivors: CacheIndexEntry[] = [];
  entries.forEach((entry) => {
    if (entry.kind !== kind) {
      survivors.push(entry);
      return;
    }
    kept += 1;
    if (kept > limit) {
      try {
        storage.removeItem(entry.key);
      } catch {}
      return;
    }
    survivors.push(entry);
  });
  writeIndex(storage, scope, survivors);
}

/** 配额守卫：setItem 失败时淘汰索引中最旧的条目后重试，仍失败则放弃本次写入。 */
function persistPayload(
  storage: SessionOfflineCacheStorage,
  scope: string,
  kind: CacheKind,
  key: string,
  serialized: string,
): void {
  for (let attempt = 0; attempt <= QUOTA_RETRY_LIMIT; attempt += 1) {
    try {
      storage.setItem(key, serialized);
      recordEntry(storage, scope, kind, key);
      return;
    } catch {
      const oldest = readIndex(storage, scope)
        .filter((entry) => entry.key !== key)
        .sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (!oldest) return;
      try {
        storage.removeItem(oldest.key);
      } catch {
        return;
      }
      writeIndex(
        storage,
        scope,
        readIndex(storage, scope).filter((entry) => entry.key !== oldest.key),
      );
    }
  }
}

function readPayload<T>(
  storage: SessionOfflineCacheStorage,
  key: string,
): readonly T[] {
  try {
    const raw = JSON.parse(storage.getItem(key) || 'null') as CachePayload<T> | null;
    if (!raw || !Array.isArray(raw.items)) return [];
    if (raw.version !== SESSION_OFFLINE_CACHE_VERSION) {
      // 版本不符：丢弃并清除旧格式数据，避免跨版本脏读。
      storage.removeItem(key);
      return [];
    }
    return raw.items;
  } catch {
    return [];
  }
}

export interface OfflineCacheSessionRef {
  readonly provider: string;
  readonly id: string;
  readonly projectDirName?: string;
}

export function writeCachedSessionDirectory(
  scope: string,
  requestKey: string,
  sessions: readonly Session[],
  storage?: SessionOfflineCacheStorage,
): void {
  const target = resolveStorage(storage);
  if (!target || !scope || !requestKey || sessions.length === 0) return;
  const payload: CachePayload<Session> = {
    version: SESSION_OFFLINE_CACHE_VERSION,
    updatedAt: nextCacheTimestamp(),
    items: sessions.slice(0, SESSION_OFFLINE_DIRECTORY_SESSION_LIMIT),
  };
  try {
    persistPayload(target, scope, 'directory', directoryStorageKey(scope, requestKey), JSON.stringify(payload));
  } catch {}
}

export function readCachedSessionDirectory(
  scope: string,
  requestKey: string,
  storage?: SessionOfflineCacheStorage,
): Session[] {
  const target = resolveStorage(storage);
  if (!target || !scope || !requestKey) return [];
  return [...readPayload<Session>(target, directoryStorageKey(scope, requestKey))];
}

export function writeCachedSessionMessages(
  scope: string,
  session: OfflineCacheSessionRef,
  messages: readonly ChatMessage[],
  storage?: SessionOfflineCacheStorage,
): void {
  const target = resolveStorage(storage);
  if (!target || !scope || messages.length === 0) return;
  const payload: CachePayload<ChatMessage> = {
    version: SESSION_OFFLINE_CACHE_VERSION,
    updatedAt: nextCacheTimestamp(),
    items: messages.slice(-SESSION_OFFLINE_MESSAGES_PER_SESSION_LIMIT),
  };
  try {
    persistPayload(target, scope, 'messages', messageStorageKey(scope, session), JSON.stringify(payload));
  } catch {}
}

export function readCachedSessionMessages(
  scope: string,
  session: OfflineCacheSessionRef,
  storage?: SessionOfflineCacheStorage,
): ChatMessage[] {
  const target = resolveStorage(storage);
  if (!target || !scope) return [];
  return [...readPayload<ChatMessage>(target, messageStorageKey(scope, session))];
}
