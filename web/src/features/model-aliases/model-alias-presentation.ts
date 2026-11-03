import type { Rule } from 'antd/es/form';
import { providerIds, providerNames } from '@/providers/catalog';
import type { ModelAlias } from '@/services/api';

/**
 * 模型别名（设置 → 模型别名）的纯展示 / 表单规则层。桌面 ModelAliases 与移动端设置共用。
 */

export const ALIAS_PROVIDER_IDS: readonly string[] = providerIds;

export const getAliasProviderDisplayName = (provider: string) => (
  provider === 'auto' ? '自动 (Auto)' : providerNames[provider as keyof typeof providerNames] || provider
);

export const ALIAS_PROVIDER_SELECT_OPTIONS = ALIAS_PROVIDER_IDS.map((provider) => ({
  value: provider,
  label: getAliasProviderDisplayName(provider)
}));

// target / targetProvider 在多选表单里是数组，提交前由 expandAliasSelections
// 展开成单值记录，存储层仍是「一条一个 (provider, model)」。
export const MODEL_ALIAS_FORM_DEFAULTS = {
  provider: 'all',
  targetProvider: ['auto'],
  target: [],
  priority: 0,
  enabled: true
};

export const MODEL_ALIAS_FIELD_RULES: Record<'alias' | 'target' | 'provider' | 'targetProvider', Rule[]> = {
  alias: [{ required: true, message: '请输入别名' }],
  target: [{ required: true, message: '请选择目标模型' }],
  provider: [{ required: true, message: '请选择供应商' }],
  targetProvider: [{ required: true, message: '请选择目标供应商' }]
};

export const MODEL_ALIAS_FIELD_HELP = {
  alias: '客户端请求的模型名称，通配符只能放在末尾且前缀至少 2 个字符',
  target: '实际转发到后端的模型名称；可多选，选中项与目标供应商两两组合，各自存成一条记录',
  provider: "选择 '全部' 表示对所有请求生效，否则只对该特定供应商的请求生效",
  targetProvider: "可多选。选 '自动' 表示按目标模型自动识别归属；多选供应商时只保留该供应商目录里真实存在的模型组合",
  priority: '数字越大优先级越高;同名别名按优先级降序依次尝试,target 无可用账号时自动回退到下一条'
};

export function formatAliasScope(provider: string) {
  return provider === 'all' ? '全部 (All)' : getAliasProviderDisplayName(provider);
}

export function formatAliasTargetProvider(targetProvider?: string) {
  return !targetProvider || targetProvider === 'auto' ? '自动 (Auto)' : getAliasProviderDisplayName(targetProvider);
}

/** 同名别名相邻展示，组内按优先级降序（与运行时回退顺序一致）。 */
export function sortModelAliases(aliases: ModelAlias[]) {
  return [...aliases].sort((a, b) => {
    const aliasDelta = a.alias.localeCompare(b.alias);
    if (aliasDelta !== 0) return aliasDelta;
    return (Number(b.priority) || 0) - (Number(a.priority) || 0);
  });
}

/**
 * 目标模型下拉分组：目标供应商为自动时列出全部供应商的模型，否则只列这些供应商。
 *
 * 支持多选：targetProvider 传数组时按所选供应商逐个分组（自动/空值 = 全部）。
 */
export function buildTargetModelGroups(
  modelsByProvider: Record<string, string[]>,
  targetProvider: string | string[],
  keepRecords: Array<Pick<ModelAlias, 'target' | 'targetProvider'>> = []
) {
  const selected = Array.isArray(targetProvider)
    ? targetProvider.filter((provider) => provider && provider !== 'auto')
    : (targetProvider && targetProvider !== 'auto' ? [targetProvider] : []);
  const providers = selected.length > 0 ? selected : ALIAS_PROVIDER_IDS;
  return providers
    .map((provider) => {
      // 编辑已有别名时，已保存的目标即使暂时不在目录里（目录未加载完 / 账号冷却后被收窄）
      // 也要留成可见选项，否则下拉要么被整个禁用、要么已选项无法识别，用户只能删了重建。
      const kept = keepRecords
        .filter((record) => (record.targetProvider || 'auto') === provider)
        .map((record) => String(record.target || '').trim())
        .filter(Boolean);
      return {
        provider,
        models: Array.from(new Set([...(modelsByProvider[provider] || []), ...kept])).sort()
      };
    })
    .filter((group) => group.models.length > 0)
    .concat(buildOrphanTargetGroup(modelsByProvider, keepRecords));
}

/**
 * 已保存但没有任何供应商目录收录、且归属为「自动」的目标：单独成组，保证编辑时仍可选。
 */
function buildOrphanTargetGroup(
  modelsByProvider: Record<string, string[]>,
  keepRecords: Array<Pick<ModelAlias, 'target' | 'targetProvider'>>
) {
  const known = new Set(Object.values(modelsByProvider).flat());
  const orphans = Array.from(new Set(keepRecords
    .filter((record) => !record.targetProvider || record.targetProvider === 'auto')
    .map((record) => String(record.target || '').trim())
    .filter((target) => target && !known.has(target)))).sort();
  return orphans.length > 0 ? [{ provider: 'auto', models: orphans }] : [];
}

// 上游 displayName 与 id 可能错位(如 gemini-3-flash-agent 显示为 Gemini 3.5 Flash (High)),
// 下拉与列表都带上显示名,避免用户对不上号。
export function getAliasModelLabel(modelLabels: Record<string, Record<string, string>>, provider: string, model: string) {
  return modelLabels[provider]?.[model] || '';
}

export function findAliasModelLabel(modelLabels: Record<string, Record<string, string>>, model: string) {
  for (const provider of ALIAS_PROVIDER_IDS) {
    const label = getAliasModelLabel(modelLabels, provider, model);
    if (label) return label;
  }
  return '';
}

/**
 * 多选表单值 → 待写入的别名记录列表（笛卡尔积）。
 *
 * 表单里目标供应商与目标模型都可多选，但存储仍是「一条一个 (provider, model)」——
 * 运行时路由、优先级回退、启停都按单条记录工作，多选纯粹是添加时的便利。
 *
 * 组合只在「该供应商目录里真的有这个模型」时才保留：选了 cline + opencode 与
 * cline-pass/… + opencode/… 两个模型，若 opencode 目录没有 cline-pass/… 就不生成
 * 这条无意义组合（后端 validateAliasTarget 也会以 not_in_catalog 拒绝）。
 * targetProvider 为 auto/空时无法判定归属，按所选模型的来源供应商展开。
 */
export function expandAliasSelections(
  values: {
    alias?: string;
    target?: string | string[];
    provider?: string;
    targetProvider?: string | string[];
    priority?: number;
    enabled?: boolean;
    description?: string;
  },
  modelsByProvider: Record<string, string[]>
): Array<Partial<ModelAlias>> {
  const targets = (Array.isArray(values.target) ? values.target : [values.target])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const providers = (Array.isArray(values.targetProvider)
    ? values.targetProvider
    : [values.targetProvider])
    .map((item) => String(item || '').trim())
    .filter((item) => item && item !== 'auto');
  if (targets.length === 0) return [];

  const base = {
    alias: String(values.alias || '').trim(),
    provider: values.provider || 'all',
    priority: Number(values.priority) || 0,
    enabled: values.enabled !== false,
    description: String(values.description || '').trim()
  };

  // 自动：按每个模型自身的来源供应商归属。
  if (providers.length === 0) {
    const out: Array<Partial<ModelAlias>> = [];
    targets.forEach((target) => {
      const owners = ALIAS_PROVIDER_IDS.filter((provider) => (
        (modelsByProvider[provider] || []).includes(target)
      ));
      if (owners.length === 0) {
        out.push({ ...base, target, targetProvider: 'auto' });
        return;
      }
      owners.forEach((owner) => out.push({ ...base, target, targetProvider: owner }));
    });
    return out;
  }

  const out: Array<Partial<ModelAlias>> = [];
  providers.forEach((targetProvider) => {
    targets.forEach((target) => {
      if (!(modelsByProvider[targetProvider] || []).includes(target)) return;
      out.push({ ...base, target, targetProvider });
    });
  });
  // 全部组合都被目录过滤掉时保留一条，让后端给出可读的 not_in_catalog 错误，
  // 而不是静默地什么都不提交。
  if (out.length === 0) {
    out.push({ ...base, target: targets[0], targetProvider: providers[0] });
  }
  return out;
}

export interface AliasGroup {
  alias: string;
  provider: string;
  description: string;
  enabled: boolean;
  records: ModelAlias[];
}

/** 列表按别名聚合：同一别名（+请求范围）的多条记录合成一行展示。 */
export function groupModelAliases(aliases: ModelAlias[]): AliasGroup[] {
  const groups = new Map<string, AliasGroup>();
  sortModelAliases(aliases).forEach((record) => {
    const key = `${record.alias}\u0000${record.provider || 'all'}`;
    const existing = groups.get(key);
    if (existing) {
      existing.records.push(record);
      if (record.enabled !== false) existing.enabled = true;
      if (!existing.description && record.description) existing.description = record.description;
      return;
    }
    groups.set(key, {
      alias: record.alias,
      provider: record.provider || 'all',
      description: record.description || '',
      enabled: record.enabled !== false,
      records: [record]
    });
  });
  return Array.from(groups.values());
}
