import { providerNames } from '@/providers/catalog';
import type { ManagedOpenAIModelItem, Provider } from '@/types';
import type { ModelStatusFilter } from './model-catalog';

/**
 * 单账号模型页（/accounts/:provider/:accountRef/models）的纯数据层：
 * 排序、筛选、OpenCode 分组计数、账号标题。桌面 Models.tsx 账号分支与移动端 MobileAccountModels 共用。
 */

export type ModelGroupFilter = 'all' | 'go' | 'zen' | 'free';

export function getModelRowKey(model: Pick<ManagedOpenAIModelItem, 'accountRef' | 'id'>) {
  return `${model.accountRef || 'global'}:${model.id}`;
}

// 从模型 id 抽取版本向量做"版本判断"：claude-opus-4-8 → [4,8]、gpt-5 → [5]、gemini-2.5-pro → [2,5]。
export function parseModelVersion(id: string): number[] {
  const matches = String(id || '').match(/\d+/g);
  return matches ? matches.map((chunk) => Number(chunk)) : [];
}

// 版本降序：越新（版本号越大）的模型排越前；缺失位补 -1 让"无版本"沉底。
export function compareModelVersionDesc(leftId: string, rightId: string) {
  const left = parseModelVersion(leftId);
  const right = parseModelVersion(rightId);
  const len = Math.max(left.length, right.length);
  for (let index = 0; index < len; index += 1) {
    const leftValue = left[index] ?? -1;
    const rightValue = right[index] ?? -1;
    if (leftValue !== rightValue) return rightValue - leftValue;
  }
  return 0;
}

// 账号模型列表排序：默认模型永远置顶 → 其次版本新→旧 → 最后 id 兜底。
export function compareAccountModelRows(left: ManagedOpenAIModelItem, right: ManagedOpenAIModelItem) {
  const leftDefault = left.defaultModel === true ? 0 : 1;
  const rightDefault = right.defaultModel === true ? 0 : 1;
  if (leftDefault !== rightDefault) return leftDefault - rightDefault;
  return compareModelVersionDesc(left.id, right.id) || left.id.localeCompare(right.id);
}

export function modelMatchesStatus(model: ManagedOpenAIModelItem, status: ModelStatusFilter) {
  if (status === 'enabled') return model.enabled !== false;
  if (status === 'disabled') return model.enabled === false;
  if (status === 'manual') return model.manual === true;
  return true;
}

export function modelMatchesGroup(model: Pick<ManagedOpenAIModelItem, 'id'>, group: ModelGroupFilter) {
  if (group === 'go') return model.id.startsWith('opencode-go/');
  if (group === 'zen') return model.id.startsWith('opencode/');
  if (group === 'free') return model.id.endsWith('-free');
  return true;
}

export interface AccountModelFilters {
  provider: Provider | 'all';
  accountRef: string | 'all';
  status: ModelStatusFilter;
  group: ModelGroupFilter;
  /** 已 trim + lowercase 的关键字 */
  query: string;
}

/** 账号模型行：按 Provider / 账号 / 状态 / OpenCode 分组 / 关键字过滤后，默认模型置顶 + 版本新→旧。 */
export function filterAccountModelRows(
  models: ManagedOpenAIModelItem[],
  filters: AccountModelFilters,
  getAccountLabelFor: (model: ManagedOpenAIModelItem) => string
) {
  return models.filter((model) => {
    if (filters.provider !== 'all' && model.provider !== filters.provider) return false;
    if (filters.accountRef !== 'all' && model.accountRef !== filters.accountRef) return false;
    if (!modelMatchesStatus(model, filters.status)) return false;
    if (!modelMatchesGroup(model, filters.group)) return false;
    if (!filters.query) return true;
    return model.id.toLowerCase().includes(filters.query)
      || model.accountRef.toLowerCase().includes(filters.query)
      || getAccountLabelFor(model).toLowerCase().includes(filters.query);
  }).sort(compareAccountModelRows);
}

/** OpenCode 账号的 Go 订阅 / Zen 按量 / Free 免费分组计数。 */
export function countOpenCodeGroups(models: Array<Pick<ManagedOpenAIModelItem, 'id'>>) {
  return {
    go: models.filter((model) => model.id.startsWith('opencode-go/')).length,
    zen: models.filter((model) => model.id.startsWith('opencode/')).length,
    free: models.filter((model) => model.id.endsWith('-free')).length
  };
}

/** 账号标题：真实名称优先；只有内部 acct_ 引用时回落为「<Provider> 账号」。 */
export function formatScopedAccountTitle(label: string, provider: Provider | null) {
  if (label && !label.startsWith('acct_')) return label;
  return provider ? `${providerNames[provider]} 账号` : '当前账号';
}
