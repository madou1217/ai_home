import sharedProviderCatalog from '../../../../lib/provider-catalog.js';

// =============================================================================
// Provider 数据目录（Node 安全）。
// -----------------------------------------------------------------------------
// 稳定身份/展示元数据来自 lib/provider-catalog-data.json，server 与 Web 共用同一份目录。
// 这里【不能】出现 SVG import / `@/` 别名 / React 类型，否则 Node 测试无法加载。
// 图标等前端视觉资源由 `provider-registry.ts` 在此基础上叠加。
// =============================================================================

export const PROVIDER_CATALOG = sharedProviderCatalog.PROVIDER_CATALOG;
export const CATALOG_FALLBACK = sharedProviderCatalog.CATALOG_FALLBACK;
export const providerIds = Object.freeze(sharedProviderCatalog.listProviderIds());

export function getProviderLabel(provider) {
  const meta = sharedProviderCatalog.getProviderMeta(provider);
  return meta.label || (provider ? String(provider) : 'AI');
}

export function getProviderTagColor(provider) {
  return sharedProviderCatalog.getProviderMeta(provider).tagColor || 'blue';
}

export function getProviderTerminalIcon(provider) {
  return sharedProviderCatalog.getProviderTerminalIcon(provider);
}

export function getProviderTerminalIconAsset(provider) {
  return sharedProviderCatalog.getProviderTerminalIconAsset(provider);
}

export function getProviderTerminalBadge(provider) {
  return sharedProviderCatalog.getProviderTerminalBadge(provider);
}

export const providerNames = Object.freeze(Object.fromEntries(
  providerIds.map((provider) => [provider, getProviderLabel(provider)])
));
