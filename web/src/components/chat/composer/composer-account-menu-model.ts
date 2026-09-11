import { getProviderLabel, providerIds } from '@/providers/catalog';

export interface ComposerAccountOption {
  readonly id: string;
  readonly label: string;
  readonly badge?: string;
  readonly provider?: string;
}

export interface ComposerAccountGroup {
  readonly provider: string;
  readonly label: string;
  readonly options: readonly ComposerAccountOption[];
}

/**
 * 账号选择器只在这里组织 Provider 层级，渲染层不再重复推导分组和顺序。
 */
export function buildComposerAccountGroups(
  options: readonly ComposerAccountOption[],
): readonly ComposerAccountGroup[] {
  const grouped = new Map<string, ComposerAccountOption[]>();
  options.forEach((option) => {
    const provider = option.provider || '';
    const entries = grouped.get(provider) || [];
    entries.push(option);
    grouped.set(provider, entries);
  });
  const catalogOrder = new Map<string, number>(
    providerIds.map((provider, index) => [provider, index]),
  );
  return [...grouped.entries()]
    .sort(([left], [right]) => (
      (catalogOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (catalogOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
    ))
    .map(([provider, entries]) => ({
      provider,
      label: provider === 'codex' ? 'ChatGPT · Codex' : provider ? getProviderLabel(provider) : '其他',
      options: entries,
    }));
}
