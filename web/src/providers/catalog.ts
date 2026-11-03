import {
  PROVIDER_AUTH_OPTIONS,
  PROVIDER_CATALOG,
  PROVIDER_FALLBACK,
  PROVIDER_IDS,
  type ProviderAuthMode,
  type ProviderAuthOption,
  type ProviderCatalogEntry,
  type ProviderFamily,
  type ProviderId,
  type ProviderSite,
} from './provider-contract.generated';

// Client 只消费生成的 TypeScript 投影，不直接导入 Node Server 模块。
export {
  PROVIDER_AUTH_OPTIONS,
  PROVIDER_CATALOG,
  PROVIDER_FALLBACK,
  type ProviderAuthMode,
  type ProviderAuthOption,
  type ProviderCatalogEntry,
  type ProviderFamily,
  type ProviderId,
  type ProviderSite,
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

// ---------------------------------------------------------------------------
// 产品族 / 站点
//
// 同一产品族的国内站与国际站**账号体系不互通**（各自发凭据、同一自然人两边是
// 不同账号），所以它们在合同里始终是两个独立 Provider——身份轴、accountRef、
// 存储投影都按 Provider 分派，绝不能因为"菜单合并了"就把账号混在一起。
//
// 这里只做**展示聚合**：把同族 Provider 收进一个入口，站点降为二级选择。
// 所有列表页都从这里取分组，避免每个页面各自硬编码 "qodercn" 之类的名单。
// ---------------------------------------------------------------------------

/** 站点排列顺序：国际站在前（合同约定无后缀 = 国际站）。 */
const SITE_ORDER: readonly ProviderSite[] = ['global', 'cn'];

const SITE_LABELS: Readonly<Record<ProviderSite, string>> = {
  global: '国际站',
  cn: '国内站',
};

export interface ProviderFamilyGroup {
  readonly family: ProviderFamily;
  /** 族名：取国际站成员的标签（没有站点后缀 = 产品本名），单站产品即自身标签。 */
  readonly label: string;
  /** 按站点顺序排列的成员；顺序稳定，UI 不再二次排序。 */
  readonly providers: readonly ProviderCatalogEntry[];
  /** 是否多站点产品——决定 UI 要不要展示站点二级选择。 */
  readonly multiSite: boolean;
}

function siteRank(site: ProviderSite): number {
  const index = SITE_ORDER.indexOf(site);
  return index < 0 ? SITE_ORDER.length : index;
}

const PROVIDER_ENTRIES: readonly ProviderCatalogEntry[] = providerIds.map(
  (provider) => PROVIDER_CATALOG[provider],
);

/** 按产品族聚合的 Provider 分组，顺序跟随产品顺序中的首次出现。 */
export const providerFamilies: readonly ProviderFamilyGroup[] = (() => {
  const buckets = new Map<string, ProviderCatalogEntry[]>();
  for (const entry of PROVIDER_ENTRIES) {
    const entries = buckets.get(entry.family) || [];
    entries.push(entry);
    buckets.set(entry.family, entries);
  }
  return [...buckets.values()].map((entries): ProviderFamilyGroup => {
    const providers = [...entries].sort((left, right) => siteRank(left.site) - siteRank(right.site));
    const named = providers.find((entry) => entry.site === 'global') || providers[0];
    return {
      family: named.family,
      label: named.label,
      providers,
      multiSite: providers.length > 1,
    };
  });
})();

const FAMILY_GROUP_BY_PROVIDER = new Map<string, ProviderFamilyGroup>(
  providerFamilies.flatMap((group) => group.providers.map((entry) => [entry.id as string, group])),
);

/** 读取 Provider 所属的产品族分组；未知 Provider 返回 null。 */
export function getProviderFamilyGroup(
  provider: string | undefined | null,
): ProviderFamilyGroup | null {
  return FAMILY_GROUP_BY_PROVIDER.get(String(provider || '').trim().toLowerCase()) || null;
}

/** 读取 Provider 的产品族标识；未知 Provider 回退为自身。 */
export function getProviderFamily(provider: string | undefined | null): string {
  return getProviderFamilyGroup(provider)?.family || String(provider || '').trim().toLowerCase();
}

/** 读取 Provider 归属的站点。 */
export function getProviderSite(provider: string | undefined | null): ProviderSite {
  return getProviderMeta(provider).site;
}

/** 站点的用户可见名称；未知站点返回空串（调用方据此不渲染标记）。 */
export function getProviderSiteLabel(site: ProviderSite | string | undefined | null): string {
  return SITE_LABELS[String(site || '').trim() as ProviderSite] || '';
}

/**
 * 列表/菜单里展示单个 Provider 的名称。
 *
 * 多站点产品必须带站点，否则同族的两个 Provider 看起来一模一样；单站产品直接用
 * 族名，避免出现"Codex · 国际站"这种零信息量的后缀。
 */
export function getProviderMenuLabel(provider: string | undefined | null): string {
  const group = getProviderFamilyGroup(provider);
  if (!group) return getProviderLabel(provider);
  if (!group.multiSite) return group.label;
  const siteLabel = getProviderSiteLabel(getProviderSite(provider));
  return siteLabel ? `${group.label} · ${siteLabel}` : group.label;
}

/** 产品族的展示名。 */
export function getFamilyLabel(family: string): string {
  return providerFamilies.find((entry) => entry.family === family)?.label || family;
}

/** 按产品族 + 站点反查真实 Provider ID；该组合不存在时返回 ''。 */
export function resolveProviderBySite(family: string, site: ProviderSite): ProviderId | '' {
  const group = providerFamilies.find((entry) => entry.family === family);
  const match = group?.providers.find((entry) => entry.site === site);
  return match ? match.id : '';
}

/** Provider 是否属于多站点产品族（UI 据此决定是否展示站点选择）。 */
export function isMultiSiteProvider(provider: string | undefined | null): boolean {
  return getProviderFamilyGroup(provider)?.multiSite === true;
}

/**
 * 把一个 provider 集合收敛成"族级"条目：每个多站点产品只保留一个入口，
 * 供 tab / 筛选 / 下拉这类不允许出现两个同族条目的视图使用。
 *
 * 返回值是每族的**代表 Provider**（默认取国际站成员，即组内第一个），账号仍按
 * `group.providers` 逐个筛，调用方不要用代表去替代成员。
 */
export function collapseProvidersToFamilies(
  providers: readonly string[],
): readonly ProviderFamilyGroup[] {
  const seen = new Set<string>();
  const groups: ProviderFamilyGroup[] = [];
  for (const provider of providers) {
    const group = getProviderFamilyGroup(provider);
    if (!group || seen.has(group.family)) continue;
    seen.add(group.family);
    groups.push(group);
  }
  return groups;
}

/** 族分组在给定账号集合上的代表 Provider（用于 tab 选中态与统计口径）。 */
export function resolveFamilyRepresentative(group: ProviderFamilyGroup): string {
  return group.providers[0]?.id || group.family;
}

export interface ProviderSelectLeafOption {
  readonly label: string;
  readonly value: ProviderId;
}

export interface ProviderSelectOptionGroup {
  readonly label: string;
  readonly options: readonly ProviderSelectLeafOption[];
}

/** AntD `Select` 的 options 项：叶子选项或一个产品族分组。 */
export type ProviderSelectOption = ProviderSelectLeafOption | ProviderSelectOptionGroup;

/**
 * 构建 provider 下拉的选项树：多站点产品收进一个分组，站点是组内二级选项。
 *
 * 集中在这里，是为了让每个页面用同一份"产品族 → 站点"形状，而不是各自拼 OptGroup
 * （拼漏一处就会出现同一个产品两个平级条目）。`value` 始终是真实 Provider ID，
 * 展示合并不改变任何提交链路。
 */
export function buildProviderSelectOptions(): readonly ProviderSelectOption[] {
  return providerFamilies.map((group): ProviderSelectOption => {
    if (!group.multiSite) {
      const only = group.providers[0];
      return { label: getProviderMenuLabel(only.id), value: only.id };
    }
    return {
      label: group.label,
      options: group.providers.map((entry) => ({
        label: getProviderMenuLabel(entry.id),
        value: entry.id,
      })),
    };
  });
}

/**
 * Provider ID 到用户可见名称的只读映射。
 *
 * 取的是 `getProviderMenuLabel`，即多站点产品带上站点（"CodeBuddy · 国内站"）：
 * 国内站与国际站是账号体系互不通的两个 Provider，任何列出 Provider 的地方都必须
 * 能分辨它们是哪个站点，否则同一个产品会看起来有两行同名条目。
 *
 * 定义在文件末尾是刻意的——它依赖上面 `providerFamilies` 的模块初始化结果，
 * 提前定义会命中暂时性死区。
 */
export const providerNames = Object.freeze(Object.fromEntries(
  providerIds.map((provider) => [provider, getProviderMenuLabel(provider)]),
)) as Readonly<Record<ProviderId, string>>;
