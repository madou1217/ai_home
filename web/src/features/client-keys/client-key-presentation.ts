import type { DefaultOptionType } from 'antd/es/select';
import type { ClientKeyLimits, ClientKeyRow } from '@/types';
import {
  buildProviderSelectOptions,
  getProviderMenuLabel,
  providerIds
} from '@/providers/catalog';

export interface ClientKeyFormValues {
  name: string;
  maxConcurrency: number;
  rpmLimit: number;
  tpmLimit: number;
  dailyTokenLimit: number;
  allowedProviders: string[];
  allowedModels: string[];
}

export interface AllowedModelGroup {
  provider: string;
  label: string;
  models: string[];
}

export interface PoolCellSummary {
  restricted: boolean;
  isMaster: boolean;
  count: number;
  primaryLabel: string;
  overflowCount: number;
  tooltipTitle: string;
  tooltipItems: string[];
}

export const ORPHAN_MODEL_GROUP_KEY = '__saved_unlisted__';

export const EMPTY_CLIENT_KEY_FORM: ClientKeyFormValues = {
  name: '',
  maxConcurrency: 0,
  rpmLimit: 0,
  tpmLimit: 0,
  dailyTokenLimit: 0,
  allowedProviders: [],
  allowedModels: []
};

const PROVIDER_ORDER_INDEX = new Map<string, number>(
  providerIds.map((provider, index) => [provider, index])
);

function compareProviders(left: string, right: string): number {
  const leftRank = PROVIDER_ORDER_INDEX.get(left);
  const rightRank = PROVIDER_ORDER_INDEX.get(right);
  if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
  if (leftRank !== undefined) return -1;
  if (rightRank !== undefined) return 1;
  return left.localeCompare(right);
}

/** 去重并清理空白，按稳定顺序返回字符串数组（用于表单规范化与脏检查）。 */
export function normalizeStringList(values: unknown, sortMode: 'alpha' | 'provider' = 'alpha'): string[] {
  const raw = Array.isArray(values)
    ? values
    : (typeof values === 'string' && values ? [values] : []);
  const unique = Array.from(new Set(raw.map((item) => String(item || '').trim()).filter(Boolean)));
  return sortMode === 'provider' ? unique.sort(compareProviders) : unique.sort((a, b) => a.localeCompare(b));
}

export function readClientKeyFormValues(row: ClientKeyRow | null): ClientKeyFormValues {
  if (!row) return { ...EMPTY_CLIENT_KEY_FORM, allowedProviders: [], allowedModels: [] };
  return {
    name: String(row.name || '').trim(),
    maxConcurrency: Number(row.limits?.maxConcurrency || 0),
    rpmLimit: Number(row.limits?.rpmLimit || 0),
    tpmLimit: Number(row.limits?.tpmLimit || 0),
    dailyTokenLimit: Number(row.limits?.dailyTokenLimit || 0),
    allowedProviders: normalizeStringList(row.limits?.allowedProviders, 'provider'),
    allowedModels: normalizeStringList(row.limits?.allowedModels, 'alpha')
  };
}

export function normalizeClientKeyForm(values: Partial<ClientKeyFormValues> | undefined): ClientKeyFormValues {
  return {
    name: String(values?.name || '').trim(),
    maxConcurrency: Number(values?.maxConcurrency || 0),
    rpmLimit: Number(values?.rpmLimit || 0),
    tpmLimit: Number(values?.tpmLimit || 0),
    dailyTokenLimit: Number(values?.dailyTokenLimit || 0),
    allowedProviders: normalizeStringList(values?.allowedProviders, 'provider'),
    allowedModels: normalizeStringList(values?.allowedModels, 'alpha')
  };
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function clientKeyFormsEqual(left: ClientKeyFormValues, right: ClientKeyFormValues): boolean {
  return left.name === right.name
    && left.maxConcurrency === right.maxConcurrency
    && left.rpmLimit === right.rpmLimit
    && left.tpmLimit === right.tpmLimit
    && left.dailyTokenLimit === right.dailyTokenLimit
    && stringArraysEqual(left.allowedProviders, right.allowedProviders)
    && stringArraysEqual(left.allowedModels, right.allowedModels);
}

export function buildClientKeyLimitsPayload(values: ClientKeyFormValues): ClientKeyLimits {
  return {
    maxConcurrency: Number(values.maxConcurrency || 0),
    rpmLimit: Number(values.rpmLimit || 0),
    tpmLimit: Number(values.tpmLimit || 0),
    dailyTokenLimit: Number(values.dailyTokenLimit || 0),
    allowedProviders: [...values.allowedProviders],
    allowedModels: [...values.allowedModels]
  };
}

export function getClientKeyProviderName(provider: string): string {
  const normalized = String(provider || '').trim();
  if (!normalized) return '';
  return PROVIDER_ORDER_INDEX.has(normalized) ? getProviderMenuLabel(normalized) : normalized;
}

/**
 * 构建账号池（Provider）多选下拉选项：复用产品族/站点分组，并兜底保留已保存但不在内置目录中的 Provider ID。
 */
export function buildAccountPoolSelectOptions(extraProviders: readonly string[] = []): DefaultOptionType[] {
  const base: DefaultOptionType[] = buildProviderSelectOptions().map((option): DefaultOptionType => (
    'options' in option
      ? {
        label: option.label,
        options: option.options.map((child) => ({
          label: child.label,
          value: child.value
        }))
      }
      : {
        label: option.label,
        value: option.value
      }
  ));
  const extras = normalizeStringList(extraProviders, 'provider').filter(
    (provider) => !PROVIDER_ORDER_INDEX.has(provider)
  );
  extras.forEach((provider) => {
    base.push({ label: provider, value: provider });
  });
  return base;
}

export function getClientKeyModelLabel(
  modelLabels: Record<string, Record<string, string>>,
  provider: string,
  model: string
): string {
  return modelLabels[provider]?.[model] || '';
}

export function findClientKeyModelLabel(
  modelLabels: Record<string, Record<string, string>>,
  model: string
): string {
  for (const provider of providerIds) {
    const label = getClientKeyModelLabel(modelLabels, provider, model);
    if (label) return label;
  }
  for (const provider of Object.keys(modelLabels)) {
    const label = getClientKeyModelLabel(modelLabels, provider, model);
    if (label) return label;
  }
  return '';
}

/**
 * 收集指定账号池下可用的模型集合；未指定账号池时返回全目录模型集合。
 */
export function collectModelsForProviders(
  modelsByProvider: Record<string, string[]>,
  allowedProviders: readonly string[]
): Set<string> {
  const providers = allowedProviders.length > 0
    ? allowedProviders
    : Object.keys(modelsByProvider);
  const allowed = new Set<string>();
  providers.forEach((provider) => {
    (modelsByProvider[provider] || []).forEach((model) => {
      const trimmed = String(model || '').trim();
      if (trimmed) allowed.add(trimmed);
    });
  });
  return allowed;
}

/**
 * 当账号池选择变化时，剔除不属于所选账号池的模型选项。
 */
export function pruneInvalidModelsForProviders(
  selectedModels: readonly string[],
  allowedProviders: readonly string[],
  modelsByProvider: Record<string, string[]>,
  modelsLoaded: boolean
): { kept: string[]; removedCount: number } {
  const normalizedModels = normalizeStringList(selectedModels, 'alpha');
  const normalizedProviders = normalizeStringList(allowedProviders, 'provider');
  if (normalizedProviders.length === 0 || normalizedModels.length === 0) {
    return { kept: normalizedModels, removedCount: 0 };
  }
  const hasAnyCatalogData = modelsLoaded || Object.keys(modelsByProvider).length > 0;
  if (!hasAnyCatalogData) {
    return { kept: normalizedModels, removedCount: 0 };
  }
  const validModels = collectModelsForProviders(modelsByProvider, normalizedProviders);
  const kept = normalizedModels.filter((model) => validModels.has(model));
  return {
    kept,
    removedCount: normalizedModels.length - kept.length
  };
}

/**
 * 按 Provider 分组构建模型池多选选项。
 * - allowedProviders 为空时列出全部有模型的 Provider；
 * - allowedProviders 非空时严格收窄到所选 Provider；
 * - 未限定账号池（或目录尚未加载完成）时，保留未在当前目录中的已选模型，避免编辑已有 Key 时丢失可见项。
 */
export function buildAllowedModelGroups(
  modelsByProvider: Record<string, string[]>,
  allowedProviders: readonly string[],
  keptModels: readonly string[] = [],
  modelsLoaded = true
): AllowedModelGroup[] {
  const normalizedProviders = normalizeStringList(allowedProviders, 'provider');
  const candidateProviders = normalizedProviders.length > 0
    ? normalizedProviders
    : normalizeStringList([...providerIds, ...Object.keys(modelsByProvider)], 'provider');

  const groups: AllowedModelGroup[] = [];
  const listedModels = new Set<string>();

  candidateProviders.forEach((provider) => {
    const models = normalizeStringList(modelsByProvider[provider] || [], 'alpha');
    if (models.length === 0) return;
    models.forEach((model) => listedModels.add(model));
    groups.push({
      provider,
      label: getClientKeyProviderName(provider),
      models
    });
  });

  if (normalizedProviders.length === 0 || !modelsLoaded) {
    const orphans = normalizeStringList(keptModels, 'alpha').filter((model) => !listedModels.has(model));
    if (orphans.length > 0) {
      groups.push({
        provider: ORPHAN_MODEL_GROUP_KEY,
        label: modelsLoaded ? '已选模型（当前目录未收录）' : '已配置模型',
        models: orphans
      });
    }
  }

  return groups;
}

export function formatLimitText(limits?: ClientKeyRow['limits']): string {
  return `并发 ${limits?.maxConcurrency || '不限'} · RPM ${limits?.rpmLimit || '不限'} · TPM ${limits?.tpmLimit || '不限'} · 日 Tokens ${limits?.dailyTokenLimit || '不限'}`;
}

export function summarizeProviderPool(
  allowedProviders: readonly string[] | undefined,
  isMaster = false
): PoolCellSummary {
  if (isMaster) {
    return {
      restricted: false,
      isMaster: true,
      count: 0,
      primaryLabel: '不限',
      overflowCount: 0,
      tooltipTitle: '账号池：不限（系统总 key）',
      tooltipItems: ['系统总 key 不受账号池白名单限制']
    };
  }
  const list = normalizeStringList(allowedProviders, 'provider');
  if (list.length === 0) {
    return {
      restricted: false,
      isMaster: false,
      count: 0,
      primaryLabel: '不限',
      overflowCount: 0,
      tooltipTitle: '账号池：不限',
      tooltipItems: ['允许路由到全部供应商账号池']
    };
  }
  const labels = list.map(getClientKeyProviderName);
  return {
    restricted: true,
    isMaster: false,
    count: list.length,
    primaryLabel: labels[0],
    overflowCount: Math.max(0, list.length - 1),
    tooltipTitle: `已限定 ${list.length} 个账号池`,
    tooltipItems: labels
  };
}

export function summarizeModelPool(
  allowedModels: readonly string[] | undefined,
  modelLabels: Record<string, Record<string, string>>,
  isMaster = false
): PoolCellSummary {
  if (isMaster) {
    return {
      restricted: false,
      isMaster: true,
      count: 0,
      primaryLabel: '不限',
      overflowCount: 0,
      tooltipTitle: '模型池：不限（系统总 key）',
      tooltipItems: ['系统总 key 不受模型池白名单限制']
    };
  }
  const list = normalizeStringList(allowedModels, 'alpha');
  if (list.length === 0) {
    return {
      restricted: false,
      isMaster: false,
      count: 0,
      primaryLabel: '不限',
      overflowCount: 0,
      tooltipTitle: '模型池：不限',
      tooltipItems: ['允许使用网关全部可用模型']
    };
  }
  const tooltipItems = list.map((model) => {
    const label = findClientKeyModelLabel(modelLabels, model);
    return label && label !== model ? `${model} — ${label}` : model;
  });
  return {
    restricted: true,
    isMaster: false,
    count: list.length,
    primaryLabel: list[0],
    overflowCount: Math.max(0, list.length - 1),
    tooltipTitle: `已限定 ${list.length} 个模型`,
    tooltipItems
  };
}

export function formatPersistedProviderPool(allowedProviders: readonly string[]): string {
  const list = normalizeStringList(allowedProviders, 'provider');
  if (list.length === 0) return '不限（全部供应商）';
  const labels = list.map(getClientKeyProviderName);
  return labels.length <= 3 ? labels.join('、') : `${labels.slice(0, 3).join('、')} 等 ${labels.length} 个`;
}

export function formatPersistedModelPool(allowedModels: readonly string[]): string {
  const list = normalizeStringList(allowedModels, 'alpha');
  if (list.length === 0) return '不限（全部模型）';
  return list.length <= 2 ? list.join('、') : `${list.slice(0, 2).join('、')} 等 ${list.length} 个`;
}

export function extractApiErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { detail?: string; message?: string; error?: string } } } | null)?.response?.data;
  return data?.detail || data?.message || data?.error || (error as { message?: string } | null)?.message || fallback;
}
