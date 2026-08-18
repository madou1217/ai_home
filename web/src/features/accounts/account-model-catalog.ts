import type {
  Account,
  WebUiOpenAIModelsJob,
  WebUiOpenAIModelsResponse,
  WebUiModelsResponse
} from '@/types';

// 账号模型目录（/models 探测）纯函数模块。
// 从 Accounts.tsx 抽取：模型探测的取数、合并、文案与颜色推导集中于此，
// 组件/hook 只负责触发刷新与展示。

export function getAccountRef(record: Pick<Account, 'accountRef'>) {
  return String(record.accountRef || '').trim();
}

export function getModelRefreshAccountRef(record: Pick<Account, 'accountRef'>) {
  return getAccountRef(record);
}

export function getModelCatalogAccountScope(record: Pick<Account, 'accountRef'>) {
  const accountRef = getAccountRef(record);
  return {
    accountRef
  };
}

export function getModelCatalogJobAccountRef(job: WebUiOpenAIModelsJob) {
  const scope = job.accountScope;
  if (!scope) return '';
  return String(scope.accountRef || '').trim();
}

export function isModelCatalogJobActive(job: WebUiOpenAIModelsJob | null) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

export function buildAccountModelCatalogFromOpenAI(catalog: WebUiOpenAIModelsResponse | null): WebUiModelsResponse | null {
  if (!catalog) return null;
  return {
    ok: catalog.ok,
    cached: catalog.cached,
    updatedAt: catalog.updatedAt,
    source: catalog.source,
    sources: catalog.sources,
    scannedAccounts: catalog.scannedAccounts,
    firstError: catalog.firstError,
    models: catalog.byProvider || {},
    byAccountRef: catalog.byAccountRef || {},
    errorsByAccountRef: catalog.errorsByAccountRef || {}
  };
}

export function getAccountModelProbe(record: Account, catalog: WebUiModelsResponse | null) {
  const accountRef = getAccountRef(record);
  const modelsByAccountRef = catalog?.byAccountRef || {};
  const errorsByAccountRef = catalog?.errorsByAccountRef || {};
  const hasModels = Boolean(accountRef && Object.prototype.hasOwnProperty.call(modelsByAccountRef, accountRef));
  const hasError = Boolean(accountRef && Object.prototype.hasOwnProperty.call(errorsByAccountRef, accountRef));
  return {
    probed: Boolean(hasModels || hasError),
    models: hasModels && Array.isArray(modelsByAccountRef[accountRef]) ? modelsByAccountRef[accountRef] : [],
    error: String(hasError ? errorsByAccountRef[accountRef] : '')
  };
}

export function formatModelProbeErrorLabel(error: string) {
  const normalized = String(error || '').trim();
  if (!normalized) return '探测失败';
  const httpMatch = normalized.match(/HTTP\s+(\d{3})/i);
  if (httpMatch) return `${httpMatch[1]} 失败`;
  if (normalized.includes('PERMISSION_DENIED')) return '权限拒绝';
  if (normalized.includes('UND_ERR')) return '网络失败';
  return '探测失败';
}

export function getModelProbeTagLabel(probe: ReturnType<typeof getAccountModelProbe>, modelRefreshing: boolean) {
  if (probe.models.length > 0) return `模型 ${probe.models.length}`;
  if (probe.error) return formatModelProbeErrorLabel(probe.error);
  if (modelRefreshing) return '探测中';
  if (probe.probed) return '未发现模型';
  return '待探测';
}

export function getModelProbeTagColor(probe: ReturnType<typeof getAccountModelProbe>, modelRefreshing: boolean) {
  if (probe.models.length > 0) return probe.error ? 'warning' : 'success';
  if (probe.error) return 'error';
  if (modelRefreshing) return 'processing';
  return probe.probed ? 'default' : 'default';
}