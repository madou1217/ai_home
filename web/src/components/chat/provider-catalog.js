import providerCatalogData from '../../../../lib/provider-catalog-data.json';

// =============================================================================
// Provider 数据目录（Node 安全）。
// -----------------------------------------------------------------------------
// 稳定身份/展示元数据来自 lib/provider-catalog-data.json，server 与 Web 共用同一份目录。
// 这里【不能】出现 SVG import / `@/` 别名 / React 类型，否则 Node 测试无法加载。
// 图标等前端视觉资源由 `provider-registry.ts` 在此基础上叠加。
// =============================================================================

const PROVIDER_DEFINITIONS = Object.freeze((providerCatalogData.providers || []).map((provider) => Object.freeze({
  id: String(provider.id || '').trim().toLowerCase(),
  label: String(provider.label || '').trim(),
  short: String(provider.short || '').trim(),
  terminalIcon: String(provider.terminalIcon || '').trim(),
  terminalIconAsset: String(provider.terminalIconAsset || '').trim(),
  accentVar: String(provider.accentVar || '').trim(),
  softVar: String(provider.softVar || '').trim(),
  tagColor: String(provider.tagColor || '').trim()
})).filter((provider) => provider.id && provider.label));

export const PROVIDER_CATALOG = Object.freeze(PROVIDER_DEFINITIONS.reduce((catalog, provider) => {
  catalog[provider.id] = provider;
  return catalog;
}, {}));

export const CATALOG_FALLBACK = Object.freeze({
  id: String(providerCatalogData.fallback?.id || 'codex').trim().toLowerCase(),
  label: String(providerCatalogData.fallback?.label || 'AI').trim(),
  short: String(providerCatalogData.fallback?.short || 'AI').trim(),
  terminalIcon: String(providerCatalogData.fallback?.terminalIcon || '◌').trim(),
  terminalIconAsset: String(providerCatalogData.fallback?.terminalIconAsset || '').trim(),
  accentVar: String(providerCatalogData.fallback?.accentVar || 'var(--color-brand)').trim(),
  softVar: String(providerCatalogData.fallback?.softVar || 'var(--color-brand-soft)').trim(),
  tagColor: String(providerCatalogData.fallback?.tagColor || 'blue').trim()
});

export const providerIds = Object.freeze(PROVIDER_DEFINITIONS.map((provider) => provider.id));

export function getProviderLabel(provider) {
  return PROVIDER_CATALOG[provider]?.label || (provider ? String(provider) : 'AI');
}

export function getProviderTagColor(provider) {
  return PROVIDER_CATALOG[provider]?.tagColor || 'blue';
}

export function getProviderTerminalIcon(provider) {
  return PROVIDER_CATALOG[provider]?.terminalIcon || CATALOG_FALLBACK.terminalIcon;
}

export function getProviderTerminalIconAsset(provider) {
  return PROVIDER_CATALOG[provider]?.terminalIconAsset || CATALOG_FALLBACK.terminalIconAsset;
}

export function getProviderTerminalBadge(provider) {
  const meta = PROVIDER_CATALOG[provider] || CATALOG_FALLBACK;
  return `${meta.terminalIcon || CATALOG_FALLBACK.terminalIcon} ${meta.short || meta.label || 'AI'}`;
}

export const providerNames = Object.freeze(Object.fromEntries(
  providerIds.map((provider) => [provider, getProviderLabel(provider)])
));
