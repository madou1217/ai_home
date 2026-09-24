import { buildProviderSelectOptions, providerIds, providerNames } from '@/providers/catalog';
import type {
  ManagedOpenAIModelItem,
  OpenAIModelItem,
  Provider,
  WebUiOpenAIModelAccount,
  WebUiOpenAIModelsJob,
  WebUiOpenAIModelsResponse
} from '@/types';

/**
 * 全局模型目录（/models）的纯数据层：聚合、筛选、计数、刷新任务展示。
 * 桌面 Models.tsx 与移动端 MobileModels 共用，保证两端口径完全一致。
 */

export type ProviderFilter = Provider | 'all';
export type AccountFilter = string | 'all';
export type ModelStatusFilter = 'all' | 'enabled' | 'disabled' | 'manual';

export type GlobalModelAccount = {
  key: string;
  label: string;
  model: ManagedOpenAIModelItem;
};

export type GlobalModelRow = OpenAIModelItem & {
  accountModels: ManagedOpenAIModelItem[];
  accounts: GlobalModelAccount[];
  providers: Provider[];
  enabledCount: number;
  disabledCount: number;
  manualCount: number;
  visible: boolean;
};

export const MODEL_PROVIDERS: Provider[] = [...providerIds];

export const MODEL_STATUS_FILTER_OPTIONS: Array<{ label: string; value: ModelStatusFilter }> = [
  { label: '全部', value: 'all' },
  { label: '启用', value: 'enabled' },
  { label: '停用', value: 'disabled' },
  { label: '手动', value: 'manual' }
];

const IGNORABLE_MODEL_PROBE_ERRORS = ['operation was aborted', 'aborterror'];

export function formatUpdatedAt(value?: number) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '尚未刷新';
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function isIgnorableModelProbeError(error?: string) {
  const normalized = String(error || '').trim().toLowerCase();
  return IGNORABLE_MODEL_PROBE_ERRORS.some((pattern) => normalized.includes(pattern));
}

export function getVisibleModelProbeError(catalog: WebUiOpenAIModelsResponse | null) {
  if (!catalog) return '';
  const candidates = [catalog.firstError, ...Object.values(catalog.errorsByAccountRef || {})];
  return candidates.find((error) => error && !isIgnorableModelProbeError(error)) || '';
}

export function isCatalogJobActive(job: WebUiOpenAIModelsJob | null) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

export function formatCatalogJobStatus(job: WebUiOpenAIModelsJob | null) {
  if (!job) return '空闲';
  if (job.status === 'queued') return '排队中';
  if (job.status === 'running') return '探测中';
  if (job.status === 'succeeded') return '已完成';
  return '失败';
}

export function formatCatalogProbeScope(job: WebUiOpenAIModelsJob | null) {
  if (job?.accountScope) return '当前账号';
  return '后台调度';
}

// 账号级刷新任务的 catalog.data 会合并 alias 派生条目（网关出口口径），
// 与下方账号模型列表（探测行）口径不同；卡片计数改为按 managedData 去重，保持同屏一致。
export function getCatalogJobVisibleCount(job: WebUiOpenAIModelsJob | null) {
  const catalog = job?.catalog;
  if (!catalog) return null;
  if (!job?.accountScope) return Array.isArray(catalog.data) ? catalog.data.length : null;
  const scopeRef = String(job.accountScope.accountRef || '').trim();
  const ids = new Set(
    (Array.isArray(catalog.managedData) ? catalog.managedData : [])
      .filter((item) => !scopeRef || item.accountRef === scopeRef)
      .map((item) => String(item.id || '').trim())
      .filter(Boolean)
  );
  return ids.size;
}

export function getCatalogJobScopeKey(job: Pick<WebUiOpenAIModelsJob, 'accountScope'> | null) {
  const scope = job?.accountScope;
  if (!scope) return 'global';
  return String(scope.accountRef || '').trim() || 'global';
}

/** 从 watch 快照里挑出当前页面作用域的最新任务：进行中的优先，否则取最近一次。 */
export function pickLatestCatalogJob(jobs: WebUiOpenAIModelsJob[], scopeKey: string) {
  const sorted = [...jobs].sort((left, right) => {
    const leftAt = Number(left.finishedAt || left.startedAt || 0);
    const rightAt = Number(right.finishedAt || right.startedAt || 0);
    return rightAt - leftAt;
  });
  return sorted
    .filter((job) => getCatalogJobScopeKey(job) === scopeKey)
    .find(isCatalogJobActive) || sorted.find((job) => getCatalogJobScopeKey(job) === scopeKey) || null;
}

export function getAccountLabel(account: Pick<WebUiOpenAIModelAccount, 'displayName' | 'email' | 'accountRef' | 'provider'>) {
  if (account.displayName) return account.displayName;
  if (account.email) return account.email;
  const providerName = providerNames[account.provider];
  if (providerName && String(account.accountRef || '').startsWith('acct_')) {
    return `${providerName} 账号`;
  }
  return account.accountRef;
}

export function normalizeProvider(value: string | null): ProviderFilter {
  return value && MODEL_PROVIDERS.includes(value as Provider) ? value as Provider : 'all';
}

export function sortProviders(providers: Provider[]) {
  const order = new Map(MODEL_PROVIDERS.map((provider, index) => [provider, index]));
  return [...providers].sort((left, right) => {
    return (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right);
  });
}

export function getManagedModelSource(catalog: WebUiOpenAIModelsResponse | null): ManagedOpenAIModelItem[] {
  const managed = Array.isArray(catalog?.managedData) ? catalog.managedData : [];
  return managed.filter((model) => model.accountRef && model.provider);
}

/** 账号选项：catalog.accounts ∪ managedData 中出现的账号（∪ 作用域账号），按 provider / accountRef 排序。 */
export function buildModelAccountOptions(
  catalog: WebUiOpenAIModelsResponse | null,
  managedSource: ManagedOpenAIModelItem[],
  scope: { provider: Provider; accountRef: string } | null = null
): WebUiOpenAIModelAccount[] {
  const accountsByRef = new Map<string, WebUiOpenAIModelAccount>();
  (Array.isArray(catalog?.accounts) ? catalog.accounts : []).forEach((account) => {
    if (!account.accountRef) return;
    accountsByRef.set(account.accountRef, account);
  });
  managedSource.forEach((model) => {
    if (!model.accountRef || accountsByRef.has(model.accountRef)) return;
    accountsByRef.set(model.accountRef, {
      provider: model.provider,
      accountRef: model.accountRef,
      displayName: model.accountRef
    });
  });
  if (scope && scope.provider && scope.accountRef && !accountsByRef.has(scope.accountRef)) {
    accountsByRef.set(scope.accountRef, {
      provider: scope.provider,
      accountRef: scope.accountRef,
      displayName: scope.accountRef
    });
  }
  return Array.from(accountsByRef.values()).sort((left, right) => (
    left.provider.localeCompare(right.provider)
    || left.accountRef.localeCompare(right.accountRef)
  ));
}

export function isGlobalModelVisible(row: Pick<GlobalModelRow, 'enabledCount' | 'visible'>) {
  return row.visible || row.enabledCount > 0;
}

export function globalModelMatchesStatus(row: GlobalModelRow, status: ModelStatusFilter) {
  const visible = isGlobalModelVisible(row);
  if (status === 'enabled') return visible;
  if (status === 'disabled') return !visible && row.disabledCount > 0;
  if (status === 'manual') return visible && row.manualCount > 0;
  return visible;
}

export function globalModelMatchesQuery(row: GlobalModelRow, query: string) {
  if (!query) return true;
  return row.id.toLowerCase().includes(query)
    || row.owned_by.toLowerCase().includes(query)
    || row.accounts.some((account) => (
      account.key.toLowerCase().includes(query)
      || account.label.toLowerCase().includes(query)
    ));
}

/** 按模型 id 聚合：catalog.data（客户端可见集合）+ managedData（逐账号探测行）。 */
export function buildGlobalModelRows(
  catalog: WebUiOpenAIModelsResponse | null,
  managedSource: ManagedOpenAIModelItem[],
  accountByRef: Map<string, WebUiOpenAIModelAccount>
): GlobalModelRow[] {
  const rowsById = new Map<string, GlobalModelRow>();
  const ensureRow = (model: OpenAIModelItem | ManagedOpenAIModelItem) => {
    const id = String(model.id || '').trim();
    if (!id) return null;
    const existing = rowsById.get(id);
    if (existing) return existing;
    const row: GlobalModelRow = {
      id,
      object: 'model',
      created: Number(model.created || 0),
      owned_by: model.owned_by || 'aih',
      accountModels: [],
      accounts: [],
      providers: [],
      enabledCount: 0,
      disabledCount: 0,
      manualCount: 0,
      visible: false
    };
    rowsById.set(id, row);
    return row;
  };

  (Array.isArray(catalog?.data) ? catalog.data : []).forEach((model) => {
    const row = ensureRow(model);
    if (!row) return;
    row.visible = true;
    row.created = Number(model.created || row.created || 0);
    row.owned_by = model.owned_by || row.owned_by;
    MODEL_PROVIDERS.forEach((provider) => {
      if ((catalog?.byProvider?.[provider] || []).includes(model.id) && !row.providers.includes(provider)) {
        row.providers.push(provider);
      }
    });
  });

  managedSource.forEach((model) => {
    const row = ensureRow(model);
    if (!row) return;
    const account = accountByRef.get(model.accountRef);
    if (!row.providers.includes(model.provider)) row.providers.push(model.provider);
    row.accountModels.push(model);
    row.accounts.push({
      key: model.accountRef,
      label: account ? getAccountLabel(account) : model.accountRef,
      model
    });
    if (model.enabled === false) {
      row.disabledCount += 1;
    } else {
      row.enabledCount += 1;
    }
    if (model.manual) row.manualCount += 1;
    if (!row.owned_by || row.owned_by === 'aih') row.owned_by = model.owned_by || row.owned_by;
  });

  return Array.from(rowsById.values())
    .map((row) => {
      const accountsByRef = new Map<string, GlobalModelAccount>();
      row.accounts.forEach((account) => {
        if (!accountsByRef.has(account.key)) accountsByRef.set(account.key, account);
      });
      return {
        ...row,
        providers: sortProviders(row.providers),
        accountModels: [...row.accountModels].sort((left, right) => (
          left.provider.localeCompare(right.provider)
          || left.accountRef.localeCompare(right.accountRef)
        )),
        accounts: Array.from(accountsByRef.values()).sort((left, right) => {
          const leftDisabled = left.model.enabled === false ? 1 : 0;
          const rightDisabled = right.model.enabled === false ? 1 : 0;
          return leftDisabled - rightDisabled
            || left.model.provider.localeCompare(right.model.provider)
            || left.label.localeCompare(right.label);
        })
      };
    })
    .sort((left, right) => {
      const leftVisible = isGlobalModelVisible(left) ? 0 : 1;
      const rightVisible = isGlobalModelVisible(right) ? 0 : 1;
      return leftVisible - rightVisible || left.id.localeCompare(right.id);
    });
}

export interface GlobalModelFilters {
  provider: ProviderFilter;
  account: AccountFilter;
  status: ModelStatusFilter;
  /** 已 trim + lowercase 的关键字 */
  query: string;
}

function rowMatchesAccount(row: GlobalModelRow, account: AccountFilter) {
  return account === 'all' || row.accountModels.some((model) => model.accountRef === account);
}

export function filterGlobalModelRows(rows: GlobalModelRow[], filters: GlobalModelFilters) {
  return rows.filter((row) => {
    if (filters.provider !== 'all' && !row.providers.includes(filters.provider)) return false;
    if (!rowMatchesAccount(row, filters.account)) return false;
    if (!globalModelMatchesStatus(row, filters.status)) return false;
    return globalModelMatchesQuery(row, filters.query);
  });
}

/** Provider 芯片计数：忽略 provider 筛选本身，其余筛选照常生效。 */
export function countGlobalModelRowsByProvider(rows: GlobalModelRow[], filters: Omit<GlobalModelFilters, 'provider'>) {
  const countRows = rows.filter((row) => (
    rowMatchesAccount(row, filters.account)
    && globalModelMatchesStatus(row, filters.status)
    && globalModelMatchesQuery(row, filters.query)
  ));
  return MODEL_PROVIDERS.reduce<Record<string, number>>((acc, provider) => {
    acc[provider] = countRows.filter((model) => model.providers.includes(provider)).length;
    return acc;
  }, { all: countRows.length });
}

// 上游探测的 display_name(如 kimi 的 "K2.7 Coding")与模型 id 可能完全不同,
// 标题优先显示 displayName 与 CLI /model 选择器对齐,真实 id 收进副标题。
export function getModelDisplayLabel(catalog: WebUiOpenAIModelsResponse | null, provider: string, id: string) {
  const byModel = catalog?.labels?.[provider];
  const label = byModel ? String(byModel[id] || '').trim() : '';
  return label && label !== id ? label : '';
}

export function getGlobalModelDisplayLabel(catalog: WebUiOpenAIModelsResponse | null, row: Pick<GlobalModelRow, 'id' | 'providers'>) {
  return row.providers
    .map((provider) => getModelDisplayLabel(catalog, provider, row.id))
    .find(Boolean) || '';
}

/* ---------------------------------------------------------------------------
 * 手动添加模型（两端共用同一套默认值与选项规则）
 * ------------------------------------------------------------------------ */

export const DEFAULT_MANUAL_MODEL_PROVIDER: Provider = 'codex';

/** 打开「手动添加模型」时的默认 Provider / 账号：优先已选账号，其次 Provider 筛选，最后 codex。 */
export function resolveManualModelDefaults(
  accountOptions: WebUiOpenAIModelAccount[],
  selectedAccount: WebUiOpenAIModelAccount | null | undefined,
  preferredProvider: Provider
) {
  const account = selectedAccount && selectedAccount.provider === preferredProvider
    ? selectedAccount
    : accountOptions.find((item) => item.provider === preferredProvider) || accountOptions[0];
  return {
    provider: account?.provider || preferredProvider,
    accountRef: account?.accountRef,
    enabled: true
  };
}

/** Provider 切换后账号是否需要改选；返回应填入的 accountRef（undefined 表示该 Provider 无账号）。 */
export function resolveManualModelAccountForProvider(
  source: WebUiOpenAIModelAccount[],
  accountByRef: Map<string, WebUiOpenAIModelAccount>,
  provider: Provider,
  currentAccountRef: string
): { changed: boolean; accountRef?: string } {
  const currentAccount = accountByRef.get(currentAccountRef);
  if (currentAccount && currentAccount.provider === provider) return { changed: false, accountRef: currentAccountRef };
  return { changed: true, accountRef: source.find((account) => account.provider === provider)?.accountRef };
}

// Provider 下拉按产品族分组：多站点产品（qoder / codebuddy / workbuddy）只出现一个
// 分组，站点是组内二级选项；value 仍是真实 Provider ID，提交链路不变。没有账号的 Provider 置灰。
export function buildManualProviderOptions(accountOptions: WebUiOpenAIModelAccount[]) {
  const hasAccount = (provider: string) => accountOptions.some((account) => account.provider === provider);
  return buildProviderSelectOptions().map((option) => (
    'options' in option
      ? {
        ...option,
        options: option.options.map((child) => ({
          ...child,
          disabled: !hasAccount(child.value)
        }))
      }
      : {
        ...option,
        disabled: !hasAccount(option.value)
      }
  ));
}
