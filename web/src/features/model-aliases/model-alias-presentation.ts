import type { Rule } from 'antd/es/form';
import { providerIds, providerNames } from '@/providers/catalog';
import type { ModelAlias } from '@/services/api';

/**
 * 模型别名（设置 → 模型别名）的纯展示 / 表单规则层。桌面 ModelAliases 与移动端设置共用。
 */

export const ALIAS_PROVIDER_IDS: readonly string[] = providerIds;

export const getAliasProviderDisplayName = (provider: string) => (
  providerNames[provider as keyof typeof providerNames] || provider
);

export const ALIAS_PROVIDER_SELECT_OPTIONS = ALIAS_PROVIDER_IDS.map((provider) => ({
  value: provider,
  label: getAliasProviderDisplayName(provider)
}));

export const MODEL_ALIAS_FORM_DEFAULTS = {
  provider: 'all',
  targetProvider: 'auto',
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
  target: '实际转发到后端的模型名称',
  provider: "选择 '全部' 表示对所有请求生效，否则只对该特定供应商的请求生效",
  targetProvider: "选择 '自动' 表示按目标模型自动识别；需要跨客户端固定路由时选择具体供应商",
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

/** 目标模型下拉分组：目标供应商为自动时列出全部供应商的模型，否则只列该供应商。 */
export function buildTargetModelGroups(modelsByProvider: Record<string, string[]>, targetProvider: string) {
  const providers = targetProvider && targetProvider !== 'auto'
    ? [targetProvider]
    : ALIAS_PROVIDER_IDS;
  return providers
    .map((provider) => ({
      provider,
      models: Array.from(new Set(modelsByProvider[provider] || [])).sort()
    }))
    .filter((group) => group.models.length > 0);
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
