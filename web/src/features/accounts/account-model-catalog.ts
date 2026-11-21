import type {
  Account,
  AccountProbeStatus,
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
    errorsByAccountRef: catalog.errorsByAccountRef || {},
    accountProbedAt: catalog.accountProbedAt || {},
    accountProbeStatus: catalog.accountProbeStatus || {}
  };
}

export function getAccountModelProbe(record: Account, catalog: WebUiModelsResponse | null) {
  const accountRef = getAccountRef(record);
  const modelsByAccountRef = catalog?.byAccountRef || {};
  const errorsByAccountRef = catalog?.errorsByAccountRef || {};
  const probedAtByAccountRef = catalog?.accountProbedAt || {};
  const statusByAccountRef = catalog?.accountProbeStatus || {};
  const hasModels = Boolean(accountRef && Object.prototype.hasOwnProperty.call(modelsByAccountRef, accountRef));
  const hasError = Boolean(accountRef && Object.prototype.hasOwnProperty.call(errorsByAccountRef, accountRef));
  const probedAt = Number(accountRef ? probedAtByAccountRef[accountRef] : 0) || 0;
  const status: AccountProbeStatus | null = (accountRef ? statusByAccountRef[accountRef] : null) || null;
  return {
    // 服务端不把「探测成功但为空」写进 byAccountRef；状态读模型与时间戳都能证明探过。
    probed: Boolean(hasModels || hasError || probedAt > 0 || (status && status.state !== 'pending')),
    probedAt: Number(status?.probedAt || probedAt) || 0,
    models: hasModels && Array.isArray(modelsByAccountRef[accountRef]) ? modelsByAccountRef[accountRef] : [],
    error: String(status?.error || (hasError ? errorsByAccountRef[accountRef] : '')),
    status,
    nextAttemptAt: Number(status?.nextAttemptAt || 0) || 0
  };
}

/** 服务端探测状态的展示名。状态与退避由 Go 声明，前端只负责翻译。 */
const PROBE_STATE_LABELS: Record<AccountProbeStatus['state'], string> = {
  pending: '待探测',
  ok: '已探测',
  retrying: '重试中',
  failed: '探测失败'
};

function formatProbeTime(at: number) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 模型探测列的紧凑行内说明（tooltip 内容），不渲染成整块提示。 */
export function getModelProbeStatusDetail(probe: ReturnType<typeof getAccountModelProbe>) {
  const parts: string[] = [];
  if (probe.status) {
    parts.push(PROBE_STATE_LABELS[probe.status.state] || probe.status.state);
  } else if (!probe.probed) {
    parts.push('尚未探测');
  }
  const reason = formatModelProbeReason(probe.error, probe.status?.errorCode);
  if (reason) {
    parts.push(`原因：${reason}`);
  }
  const probedAt = formatProbeTime(probe.probedAt);
  if (probedAt) parts.push(`上次探测 ${probedAt}`);
  const nextAttemptAt = formatProbeTime(probe.nextAttemptAt);
  if (nextAttemptAt) parts.push(`下次自动重试 ${nextAttemptAt}`);
  return parts.join(' · ');
}

export function formatModelProbeReason(error: string, errorCode?: string) {
  const normalized = String(error || '').trim();
  const code = String(errorCode || '').trim();
  if (!normalized && !code) return '';
  const lower = normalized.toLowerCase();
  const status = (normalized.match(/status=(\d{3})/i) || [])[1] || '';
  if (status === '401' || status === '403' || lower.includes('认证被拒绝') || code === 'authentication_rejected') {
    return '账号认证被拒绝，请重新登录或更新凭据';
  }
  if (status === '429' || lower.includes('rate limit') || lower.includes('限流')) {
    return '上游限流，后台会自动重试';
  }
  if (status === '404') {
    return '上游没有模型目录接口（HTTP 404）';
  }
  if (/^5\d{2}$/.test(status)) {
    return `上游暂时不可用（HTTP ${status}）`;
  }
  if (lower.includes('凭据形态不支持') || code === 'discovery_unsupported') {
    return '该账号形态不支持自动发现模型';
  }
  if (lower.includes('timeout') || lower.includes('und_err') || lower.includes('econn')) {
    return '网络超时或连接失败';
  }
  if (code === 'invalid_catalog' || lower.includes('无法解析')) {
    return '上游返回的模型目录无法解析';
  }
  if (code === 'account_not_found') {
    return '账号已不存在';
  }
  const cleaned = normalized.replace(/^账号模型发现失败[:：]\s*/, '').trim();
  if (cleaned) {
    return cleaned.length > 90 ? `${cleaned.slice(0, 90)}…` : cleaned;
  }
  return code || '探测失败';
}

export function formatModelProbeErrorLabel(error: string, errorCode?: string) {
  const normalized = String(error || '').trim();
  const code = String(errorCode || '').trim();
  if (!normalized && !code) return '探测失败';
  if (normalized.includes('zcode_jwt_missing_relogin') || normalized.includes('zcode_oauth_access_token_missing')) {
    return '需重新登录';
  }
  if (normalized.includes('zcode_balance_parameter_error')) {
    return '参数错误';
  }
  const status = (normalized.match(/status=(\d{3})/i) || [])[1] || '';
  const lower = normalized.toLowerCase();
  if (status === '401' || status === '403' || code === 'authentication_rejected') return '需重新登录';
  if (status === '429' || lower.includes('rate limit') || normalized.includes('429') || lower.includes('限流')) return '限流';
  if (status === '404') return '无目录接口';
  if (/^5\d{2}$/.test(status)) return '上游异常';
  if (normalized.includes('PERMISSION_DENIED')) return '权限拒绝';
  if (normalized.includes('UND_ERR') || normalized.toLowerCase().includes('timeout')) return '网络失败';
  if (normalized.includes('凭据形态不支持') || code === 'discovery_unsupported') return '不支持发现';
  return '探测失败';
}

export function getModelProbeTagLabel(
  probe: ReturnType<typeof getAccountModelProbe>,
  modelRefreshing: boolean,
  provider?: string,
  accountStatus?: string,
  configured?: boolean
) {
  if (probe.models.length > 0) {
    if (provider === 'opencode') {
      const goCount = probe.models.filter((m: string) => String(m).startsWith('opencode-go/')).length;
      const zenPaidCount = probe.models.filter((m: string) => String(m).startsWith('opencode/') && !String(m).endsWith('-free')).length;
      const freeCount = probe.models.filter((m: string) => String(m).endsWith('-free')).length;

      const parts: string[] = [];
      if (goCount > 0) parts.push(`Go ${goCount}`);
      if (zenPaidCount > 0) parts.push(`Zen ${zenPaidCount}`);
      if (freeCount > 0) parts.push(`Free ${freeCount}`);

      return parts.join(' · ') || `模型 ${probe.models.length}`;
    }
    return `模型 ${probe.models.length}`;
  }
  if (modelRefreshing) return '探测中';
  // 关闭的账号不参与调度，后台也不会替它探测——显示「待探测」等于给用户一个永远不会兑现的承诺。
  if (String(accountStatus || '').trim().toLowerCase() === 'down') return '已关闭';
  // 失败状态优先于原始错误文案：服务端已经把它归类为「会自动重试」或「需要人工处理」。
  if (probe.status?.state === 'retrying') return '重试中';
  if (probe.status?.state === 'failed') return formatModelProbeErrorLabel(probe.error, probe.status?.errorCode);
  if (probe.error) return formatModelProbeErrorLabel(probe.error, probe.status?.errorCode);
  // 已经探测过（含「成功但目录为空」）：模型很少随账号变化，不该长期挂「待探测」。
  if (probe.probed) return '未发现模型';
  // 没有凭据的账号不会被自动探测；「未配置」比「待探测」更准确，也不会给出无法兑现的承诺。
  if (configured === false) return '未配置';
  return '待探测';
}

export function getModelProbeTagColor(probe: ReturnType<typeof getAccountModelProbe>, modelRefreshing: boolean) {
  if (probe.models.length > 0) return probe.error ? 'warning' : 'success';
  if (probe.status?.state === 'retrying') return 'processing';
  if (probe.error) return 'error';
  if (modelRefreshing) return 'processing';
  return probe.probed ? 'default' : 'default';
}
