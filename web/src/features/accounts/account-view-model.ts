import type { Account, ManagementAccountActivity, Provider } from '@/types';
import {
  PROVIDER_CATALOG,
  getProviderFamily,
  providerFamilies,
  providerIds
} from '@/providers/catalog';
import {
  getAccountDisplayState,
  requiresAccountReauth
} from '@/features/accounts/account-state';
import type { AccountDisplayStateKind } from '@/features/accounts/account-state';

// 账号页视图模型 —— 纯函数模块。
// 从 Accounts.tsx 抽取：Provider 族筛选、状态筛选、分族统计、客户端入口能力、
// 账号操作可用性与文案。桌面 Accounts.tsx 与移动端 MobileAccounts 共用，口径完全一致。

/* ---------------------------------------------------------------------------
 * Provider 族（tab / 芯片的轴）
 * ------------------------------------------------------------------------ */

export type AccountProviderFilter = 'all' | string;

export type AccountFilterValue = 'all' | AccountDisplayStateKind;

// Provider tab 的轴是**产品族**：国内站与国际站账号体系不互通，但用户视角只有一个
// 产品，因此列表按族聚合，站点降为卡片/行上的标记（见 getProviderMenuLabel）。
export const PROVIDER_FAMILY_GROUPS = providerFamilies;
export const FAMILY_KEYS: readonly string[] = PROVIDER_FAMILY_GROUPS.map((group) => group.family);

// tab/filter 的合法取值是产品族（含未知历史的 Provider id：它自成一族，仍可筛）。
export function isProviderFilter(value: string): boolean {
  const key = String(value || '').trim().toLowerCase();
  return key === 'all' || FAMILY_KEYS.includes(key);
}

// URL query 里的 provider 是**真实 Provider ID**（含站点后缀），与 tab 的族轴不同。
export function isProviderId(value: string): value is Provider {
  return providerIds.includes(value as Provider);
}

// 族 tab 上展示的图标与活动转轴，用族内代表（国际站成员）即可。
export function familyRepresentative(family: string): Provider {
  const group = PROVIDER_FAMILY_GROUPS.find((entry) => entry.family === family);
  return ((group?.providers[0]?.id) || family) as Provider;
}

/** 「添加账号」弹窗默认 Provider：跟随当前族 tab（族 → 其国际站成员）；「全部」不预选。 */
export function resolveAddAccountDefaultProvider(activeProvider: AccountProviderFilter): Provider | undefined {
  return isProviderFilter(activeProvider) && activeProvider !== 'all'
    ? familyRepresentative(activeProvider)
    : undefined;
}

/** 从 `?provider=&accountRef=` 深链解析目标账号；provider 必须是真实 Provider ID。 */
export function parseAccountRouteTarget(search: string): { provider: Provider; accountRef: string } | null {
  const params = new URLSearchParams(search);
  const provider = String(params.get('provider') || '').trim();
  const accountRef = String(params.get('accountRef') || '').trim();
  if (!isProviderId(provider) || !accountRef) return null;
  return { provider, accountRef };
}

const ACCOUNTS_ACTIVE_PROVIDER_STORAGE_KEY = 'accounts-active-provider-tab:v1';

export function readStoredActiveProviderTab(): AccountProviderFilter {
  if (typeof window === 'undefined') return 'all';
  try {
    const saved = window.localStorage.getItem(ACCOUNTS_ACTIVE_PROVIDER_STORAGE_KEY);
    if (saved === 'all' || isProviderFilter(saved || '')) return saved as AccountProviderFilter;
  } catch (_error) {
    // localStorage 不可用（隐私模式等）时静默回退到默认 tab。
  }
  return 'all';
}

export function persistActiveProviderTab(provider: AccountProviderFilter): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(ACCOUNTS_ACTIVE_PROVIDER_STORAGE_KEY, provider); } catch (_error) {}
}

/* ---------------------------------------------------------------------------
 * 状态筛选 + 分族统计
 * ------------------------------------------------------------------------ */

export const ACCOUNT_STATUS_FILTER_OPTIONS: ReadonlyArray<{ label: string; value: AccountFilterValue }> = [
  { label: '全部状态', value: 'all' },
  { label: '正常可用', value: 'healthy' },
  { label: '需要重新登录', value: 'reauth_required' },
  { label: '运行阻塞', value: 'runtime_blocked' },
  { label: '额度待确认', value: 'usage_attention' },
  { label: '已停池', value: 'policy_blocked' },
  { label: '已耗尽', value: 'exhausted' },
  { label: '已关闭', value: 'disabled' },
  { label: '未配置', value: 'unconfigured' }
];

export type ProviderStatsBucket = {
  total: number;
  healthy: number;
  exhausted: number;
  policyBlocked: number;
  reauthRequired: number;
  usageAttention: number;
  runtimeBlocked: number;
  disabled: number;
  unconfigured: number;
};

export type ProviderStats = Record<AccountProviderFilter, ProviderStatsBucket>;

const STATE_BUCKET_KEYS: Record<AccountDisplayStateKind, keyof ProviderStatsBucket> = {
  healthy: 'healthy',
  reauth_required: 'reauthRequired',
  exhausted: 'exhausted',
  policy_blocked: 'policyBlocked',
  usage_attention: 'usageAttention',
  runtime_blocked: 'runtimeBlocked',
  disabled: 'disabled',
  unconfigured: 'unconfigured'
};

export function createProviderStatsBucket(): ProviderStatsBucket {
  return {
    total: 0,
    healthy: 0,
    exhausted: 0,
    policyBlocked: 0,
    reauthRequired: 0,
    usageAttention: 0,
    runtimeBlocked: 0,
    disabled: 0,
    unconfigured: 0
  };
}

export function createProviderStats(): ProviderStats {
  const stats = {
    all: createProviderStatsBucket()
  } as ProviderStats;
  FAMILY_KEYS.forEach((family) => {
    stats[family] = createProviderStatsBucket();
  });
  return stats;
}

/** 把一个账号计入「全部」与其产品族两个桶（族内所有站点账号合并计数）。 */
export function tallyProviderStats(stats: ProviderStats, account: Account): void {
  const providerBucket = stats[getProviderFamily(account.provider)];
  if (!providerBucket) return;
  const key = STATE_BUCKET_KEYS[getAccountDisplayState(account)];
  stats.all.total++;
  providerBucket.total++;
  if (key) {
    stats.all[key]++;
    providerBucket[key]++;
  }
}

export function buildProviderStats(accounts: Account[]): ProviderStats {
  const stats = createProviderStats();
  accounts.forEach((account) => tallyProviderStats(stats, account));
  return stats;
}

/** 某个状态筛选值在统计桶里的计数（'all' 即总数）。 */
export function getStatusFilterCount(bucket: ProviderStatsBucket, status: AccountFilterValue): number {
  if (status === 'all') return bucket.total;
  return bucket[STATE_BUCKET_KEYS[status]] || 0;
}

/** 待处理问题 = 需登录 + 运行阻塞 + 待校准（桌面 KPI 口径）。 */
export function countPendingIssues(bucket: ProviderStatsBucket): number {
  return bucket.reauthRequired + bucket.runtimeBlocked + bucket.usageAttention;
}

/** 耗尽/停用 = 已耗尽 + 已停池（桌面 KPI 口径）。 */
export function countUnavailable(bucket: ProviderStatsBucket): number {
  return bucket.exhausted + bucket.policyBlocked;
}

/** 按产品族 + 状态过滤账号：族内国内站/国际站账号一起显示，各自带站点标记。 */
export function filterAccountsByView(
  accounts: Account[],
  activeProvider: AccountProviderFilter,
  filterStatus: AccountFilterValue
): Account[] {
  return accounts.filter((account) => (
    (activeProvider === 'all' || getProviderFamily(account.provider) === activeProvider)
    && (filterStatus === 'all' || getAccountDisplayState(account) === filterStatus)
  ));
}

/* ---------------------------------------------------------------------------
 * 网关请求活动（行首图标转轴）
 * ------------------------------------------------------------------------ */

export type AccountActivityMap = Record<string, ManagementAccountActivity>;

export function getAccountActivityKey(record: Pick<Account, 'provider' | 'accountRef'>): string {
  return `${String(record.provider).toLowerCase()}:${record.accountRef}`;
}

// 族 tab 聚合账号活动：族内多个站点（国内站/国际站）的流量相加，tab 上看到的是整个产品的活跃度。
export function aggregateFamilyActivity(
  accounts: Account[],
  getActivity: (record: Account) => ManagementAccountActivity | null
): AccountActivityMap {
  const providerActivity: AccountActivityMap = {};
  accounts.forEach((account) => {
    const activity = getActivity(account);
    if (!activity) return;
    const family = getProviderFamily(account.provider);
    const current = providerActivity[family];
    providerActivity[family] = {
      provider: familyRepresentative(family),
      accountRef: '*',
      inFlight: (current?.inFlight || 0) + Math.max(0, Number(activity.inFlight) || 0),
      rate: (current?.rate || 0) + Math.max(0, Number(activity.rate) || 0),
      lastActivityAt: Math.max(current?.lastActivityAt || 0, Number(activity.lastActivityAt) || 0),
      updatedAt: Math.max(current?.updatedAt || 0, Number(activity.updatedAt) || 0)
    };
  });
  return providerActivity;
}

/* ---------------------------------------------------------------------------
 * Desktop / CLI 客户端入口（按宿主机实测结果控制）
 * ------------------------------------------------------------------------ */

export type AccountAppEntryFlags = { desktop: boolean; cli: boolean };
export type AccountAppEntryMap = Record<string, AccountAppEntryFlags>;

export interface AccountAppSupport {
  desktopInstalled: boolean;
  desktopSupported: boolean;
  cliInstalled: boolean;
  cliSupported: boolean;
}

export function getAccountAppSupport(
  record: Pick<Account, 'provider'>,
  appEntries: AccountAppEntryMap | null,
  appCapabilities: AccountAppEntryMap
): AccountAppSupport {
  return {
    desktopInstalled: Boolean(appEntries?.[record.provider]?.desktop),
    desktopSupported: Boolean(
      appEntries?.[record.provider]?.desktop || appCapabilities[record.provider]?.desktop
    ),
    cliInstalled: Boolean(appEntries?.[record.provider]?.cli),
    cliSupported: Boolean(
      PROVIDER_CATALOG[record.provider as Provider]?.clients?.cli
        && (appEntries?.[record.provider]?.cli || appCapabilities[record.provider]?.cli)
    )
  };
}

/** 打开 Desktop / CLI 前的拦截：需重新登录或未配置时返回提示文案，可打开返回 null。 */
export function getAccountLaunchBlockReason(
  record: Pick<Account, 'apiKeyMode' | 'runtimeStatus' | 'runtimeReason' | 'configured'>,
  kindLabel: string
): string | null {
  if (requiresAccountReauth(record)) return `需要重新登录后才能打开 ${kindLabel}`;
  if (!record.configured) return `账号未配置，完成授权后可打开 ${kindLabel}`;
  return null;
}

/* ---------------------------------------------------------------------------
 * 账号操作（⋮ 菜单 / 移动端详情抽屉）的可用性与文案
 * ------------------------------------------------------------------------ */

export interface AccountRoleActionMeta {
  label: string;
  disabled: boolean;
  active: boolean;
}

export function getDefaultAccountActionMeta(record: Pick<Account, 'isDefault' | 'configured'>): AccountRoleActionMeta {
  return {
    label: record.isDefault
      ? '取消默认账号'
      : (!record.configured ? '未配置账号不能设为默认账号' : '设为默认账号'),
    disabled: Boolean(!record.isDefault && !record.configured),
    active: Boolean(record.isDefault)
  };
}

/** Codex App 账号只对 codex 生效；其它 provider 返回 null（不展示该操作）。 */
export function getCodexAppAccountActionMeta(
  record: Pick<Account, 'provider' | 'isMobile' | 'configured' | 'apiKeyMode'>
): AccountRoleActionMeta | null {
  if (record.provider !== 'codex') return null;
  return {
    label: record.isMobile
      ? '取消 Codex App 账号'
      : (!record.configured
          ? '未配置账号不能设为 Codex App 账号'
          : (record.apiKeyMode ? '密钥账号不能设为 Codex App 账号' : '设为 Codex App 账号')),
    disabled: Boolean(!record.isMobile && (!record.configured || record.apiKeyMode)),
    active: Boolean(record.isMobile)
  };
}

/** 额度重置历史只对 OAuth 账号有意义（密钥账号没有上游额度窗口）。 */
export function canViewQuotaResetHistory(record: Pick<Account, 'apiKeyMode'>): boolean {
  return !record.apiKeyMode;
}
