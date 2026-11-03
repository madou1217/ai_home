/**
 * 会话框的「账号模型目录」缓存（accountRef → 启用模型）+ 跨页面失效。
 *
 * 为什么需要（2026-10-23 用户反馈「手动新增的模型 chat 里不显示」）：
 * 打开会话时先用缓存立即渲染、后台再刷新，避免闪一下「无可用模型」。但账号模型页
 * 增删改模型后如果没人通知，chat 就会一直停在旧列表 —— 用户新加的模型在账号页看得见、
 * 在 chat 里选不到。
 *
 * 为什么失效订阅必须**模块级**而不是放在组件 effect 里：组件只有挂载时才会注册监听，
 * 而用户完全可能「在账号页加模型 → 切回 chat 但还没进任何会话」（MessageArea 未挂载）
 * → 事件丢失 → 旧缓存原样保留，问题照旧。模块级订阅在 bundle 求值时就生效。
 *
 * 持久化：localStorage 按 `当前server + accountRef` 分键，页面刷新/冷启动也能立即出模型。
 */

import { onAccountModelCatalogChanged } from '@/features/models/account-model-catalog-events';

export interface AccountModelCatalogEntry {
  /** 与调用方 state 的 `string[]` 同型：readonly 会在赋值处制造无谓的类型摩擦。 */
  ids: string[];
  defaultModel: string;
}

/** accountRef（或网关作用域键）→ 该目标的启用模型。 */
const catalogCache = new Map<string, AccountModelCatalogEntry>();

/** 每个目标一个缓存代次：失效时 +1，订阅方据此重拉（见 catalogCacheVersion）。 */
const cacheVersion = new Map<string, number>();

/** localStorage 键前缀；读方（MessageArea）用同一前缀拼具体键。 */
export const MODEL_CATALOG_STORAGE_PREFIX = 'chat-model-catalog:v1:';

export function resolveCatalogStorageKey(serverId: string, targetKey: string): string {
  return `${MODEL_CATALOG_STORAGE_PREFIX}${serverId || 'local'}:${targetKey}`;
}

export function readCachedCatalog(targetKey: string): AccountModelCatalogEntry | undefined {
  return catalogCache.get(targetKey);
}

export function writeCachedCatalog(targetKey: string, entry: AccountModelCatalogEntry): void {
  catalogCache.set(targetKey, entry);
}

/** 该目标的缓存代次。失效会 +1，订阅方在依赖里带上它即可触发重拉。 */
export function catalogCacheVersion(targetKey: string): number {
  return cacheVersion.get(targetKey) || 0;
}

/**
 * 让一个目标的缓存失效：丢内存缓存 + 丢 localStorage + 代次 +1。
 * `targetKey` 为空串表示全部（例如批量刷新）。
 */
export function invalidateCatalogCache(targetKey: string, storageKey = ''): void {
  const key = String(targetKey || '').trim();
  if (!key) {
    catalogCache.clear();
    cacheVersion.clear();
    clearPersistedCatalogs();
    return;
  }
  catalogCache.delete(key);
  cacheVersion.set(key, (cacheVersion.get(key) || 0) + 1);
  if (storageKey) removePersistedCatalog(storageKey);
}

function removePersistedCatalog(storageKey: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(storageKey);
  } catch (_error) {
    // 隐私模式 / 配额：缓存失效失败不该打断交互。
  }
}

function clearPersistedCatalogs(): void {
  if (typeof window === 'undefined') return;
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(MODEL_CATALOG_STORAGE_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch (_error) {
    // 同上。
  }
}

/**
 * 模块级订阅：账号模型页改了模型就丢掉对应缓存。
 *
 * `resolveStorageKey` 由调用方提供（它知道当前 server id）；不提供时只清内存缓存 ——
 * localStorage 里那份下次打开仍会先渲染一次，但后台刷新会立刻覆盖，不会长期停在旧值。
 */
export function installCatalogCacheInvalidation(
  resolveStorageKey?: (targetKey: string) => string
): () => void {
  return onAccountModelCatalogChanged((changedRef) => {
    const ref = String(changedRef || '').trim();
    if (!ref) {
      invalidateCatalogCache('');
      return;
    }
    invalidateCatalogCache(ref, resolveStorageKey ? resolveStorageKey(ref) : '');
  });
}

/** 测试用：清空全部状态。 */
export function resetCatalogCacheForTests(): void {
  catalogCache.clear();
  cacheVersion.clear();
}
