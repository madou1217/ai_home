import {
  getFamilyLabel,
  getProviderFamilyGroup,
  getProviderSite,
  getProviderSiteLabel,
  providerFamilies,
} from '@/providers/catalog';

export interface ComposerAccountOption {
  readonly id: string;
  readonly label: string;
  readonly badge?: string;
  readonly provider?: string;
  /**
   * 该账号所属站点的展示名；只有多站点产品（qoder / codebuddy / workbuddy）
   * 才有值。菜单按族合并后，同一族内必须靠它区分国内站与国际站账号。
   */
  readonly siteLabel?: string;
}

export interface ComposerAccountGroup {
  /** 产品族标识：同一产品的国内站/国际站共用它，所以菜单里只有一个条目。 */
  readonly family: string;
  /** 族的展示名；多站点产品刻意不带站点后缀，站点降为账号行上的标记。 */
  readonly label: string;
  /** 族内用于分组图标与 data 属性的代表 Provider。 */
  readonly provider: string;
  /** 该族在本次列表中出现的站点数（1 表示单站产品）。 */
  readonly siteCount: number;
  readonly options: readonly ComposerAccountOption[];
}

/** 产品族在目录里的顺序，避免菜单顺序随账号增删而抖动。 */
const FAMILY_ORDER = new Map<string, number>(
  providerFamilies.map((group, index) => [group.family as string, index]),
);

/** 族内站点顺序：成员在各族分组里已按站点排好，取索引即可（国际站在前）。 */
const SITE_INDEX_BY_PROVIDER = new Map<string, number>(
  providerFamilies.flatMap((group) => group.providers.map((entry, index) => [entry.id as string, index])),
);

/**
 * 账号选择器只在这里组织 Provider 层级，渲染层不再重复推导分组和顺序。
 *
 * 分组键是**产品族**而不是 Provider：国内站与国际站是账号体系互不通的两个独立
 * Provider，但用户视角只有一个产品，因此菜单里合并成一个条目，站点降为账号行
 * 上的标记（`siteLabel`）。账号本身仍严格挂在各自的 Provider 上，聚合只影响展示。
 */
export function buildComposerAccountGroups(
  options: readonly ComposerAccountOption[],
): readonly ComposerAccountGroup[] {
  const grouped = new Map<string, ComposerAccountOption[]>();
  options.forEach((option) => {
    const provider = option.provider || '';
    // 未知 Provider（本地缓存里的历史值）自成一族，不与已知产品混在一起。
    const group = provider ? getProviderFamilyGroup(provider) : null;
    const family = group ? group.family : provider;
    const entries = grouped.get(family) || [];
    if (!grouped.has(family)) grouped.set(family, entries);
    const siteLabel = group?.multiSite && provider
      ? getProviderSiteLabel(getProviderSite(provider))
      : '';
    entries.push(siteLabel ? { ...option, siteLabel } : option);
  });

  return [...grouped.entries()]
    .sort(([left], [right]) => (
      (FAMILY_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (FAMILY_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER)
    ))
    .map(([family, entries]) => {
      // 族内按站点归拢（国际站在前），站点内保持调用方给出的账号顺序。
      const ordered = [...entries].sort((left, right) => siteRank(left.provider) - siteRank(right.provider));
      return {
        family,
        label: family === 'codex' ? 'ChatGPT · Codex' : family ? getFamilyLabel(family) : '其他',
        provider: ordered.find((entry) => entry.provider)?.provider || '',
        siteCount: new Set(ordered.map((entry) => entry.siteLabel).filter(Boolean)).size || 1,
        options: ordered,
      };
    });
}

/** 未知 Provider 视为排在最后，不干扰已知产品的站点顺序。 */
function siteRank(provider: string | undefined): number {
  return SITE_INDEX_BY_PROVIDER.get(String(provider || '')) ?? Number.MAX_SAFE_INTEGER;
}
