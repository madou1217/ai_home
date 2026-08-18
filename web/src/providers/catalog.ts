import {
  PROVIDER_AUTH_OPTIONS,
  PROVIDER_CATALOG,
  PROVIDER_FALLBACK,
  PROVIDER_IDS,
  type ProviderAuthMode,
  type ProviderAuthOption,
  type ProviderCatalogEntry,
  type ProviderId,
} from './provider-contract.generated';

// Client 只消费生成的 TypeScript 投影，不直接导入 Node Server 模块。
export {
  PROVIDER_AUTH_OPTIONS,
  PROVIDER_CATALOG,
  PROVIDER_FALLBACK,
  type ProviderAuthMode,
  type ProviderAuthOption,
  type ProviderCatalogEntry,
  type ProviderId,
};

/** 按产品顺序排列的 Provider ID。 */
export const providerIds: readonly ProviderId[] = PROVIDER_IDS;

/** 按声明式能力筛选 Provider，避免消费层复制 Provider 名单。 */
export function providerIdsByCapability(capability: string): readonly ProviderId[] {
  const normalized = String(capability || '').trim();
  if (!normalized) return [];
  return providerIds.filter((provider) => PROVIDER_CATALOG[provider].capabilities.includes(normalized));
}

/** 读取 Provider 展示元数据，未知值使用安全回退。 */
export function getProviderMeta(provider: string | undefined | null): ProviderCatalogEntry {
  return PROVIDER_CATALOG[provider as ProviderId] || PROVIDER_FALLBACK;
}

/** 读取 Provider 的用户可见名称。 */
export function getProviderLabel(provider: string | undefined | null): string {
  return getProviderMeta(provider).label || (provider ? String(provider) : 'AI');
}

/** 读取 Ant Design Tag 使用的颜色。 */
export function getProviderTagColor(provider: string | undefined | null): string {
  return getProviderMeta(provider).tagColor || 'blue';
}

/** 读取终端文本图标。 */
export function getProviderTerminalIcon(provider: string | undefined | null): string {
  return getProviderMeta(provider).terminalIcon || PROVIDER_FALLBACK.terminalIcon;
}

/** 读取终端 profile 使用的图标资产标识。 */
export function getProviderTerminalIconAsset(provider: string | undefined | null): string {
  return getProviderMeta(provider).terminalIconAsset || PROVIDER_FALLBACK.terminalIconAsset;
}

/** 构建紧凑的终端 Provider 标识。 */
export function getProviderTerminalBadge(provider: string | undefined | null): string {
  const meta = getProviderMeta(provider);
  return `${meta.terminalIcon || PROVIDER_FALLBACK.terminalIcon} ${meta.short || meta.label || 'AI'}`;
}

/** 读取账号添加界面可展示的认证方式。 */
export function getProviderAuthOptions(provider: ProviderId): readonly ProviderAuthOption[] {
  return PROVIDER_AUTH_OPTIONS[provider] || [];
}

/** Provider ID 到用户可见名称的只读映射。 */
export const providerNames = Object.freeze(Object.fromEntries(
  providerIds.map((provider) => [provider, getProviderLabel(provider)]),
)) as Readonly<Record<ProviderId, string>>;
