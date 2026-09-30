import type { Account } from '@/types';

// Codex(ChatGPT) OAuth 账号的订阅状态。
//
// 两个来源，可信度不同：
// - id_token 里的订阅到期(subscriptionActiveUntilMs)只是 OpenAI 上次校验订阅时的快照，
//   刷新 token 也不一定更新，过了日期不代表过期，也不代表已续费；
// - 额度接口每次返回的实时套餐(planType)及其确认时间(planConfirmedAtMs)才是当前状态。
// 到期日之后若额度接口仍确认为付费套餐，就是已续费（或仍在宽限期内可用）；确认为 free 即已失效；
// 到期日之后还没有新的确认时，状态未知，只能靠刷新额度确认。

export type CodexSubscriptionStatus = 'active' | 'renewed' | 'lapsed' | 'unconfirmed';

export interface CodexSubscription {
  validUntilMs: number;
  lastCheckedMs: number;
  planType: string;
  planConfirmedAtMs: number;
  status: CodexSubscriptionStatus;
}

const FREE_PLANS = new Set(['free', 'guest', '']);

export function getCodexSubscription(
  record: Pick<Account, 'provider' | 'usageSnapshot'>,
  nowMs: number = Date.now()
): CodexSubscription | null {
  if (record.provider !== 'codex') return null;
  const snapshot = record.usageSnapshot;
  if (!snapshot || snapshot.kind !== 'codex_oauth_status' || !snapshot.account) return null;
  const validUntilMs = Number(snapshot.account.subscriptionActiveUntilMs) || 0;
  if (validUntilMs <= 0) return null;
  const lastCheckedMs = Number(snapshot.account.subscriptionLastCheckedMs) || 0;
  const planType = String(snapshot.account.planType || '').trim().toLowerCase();
  const planConfirmedAtMs = Number(snapshot.account.planConfirmedAtMs) || 0;
  let status: CodexSubscriptionStatus = 'active';
  if (validUntilMs <= nowMs) {
    if (planConfirmedAtMs <= validUntilMs) status = 'unconfirmed';
    else status = FREE_PLANS.has(planType) ? 'lapsed' : 'renewed';
  }
  return { validUntilMs, lastCheckedMs, planType, planConfirmedAtMs, status };
}

function formatDate(ms: number) {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTime(ms: number) {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface CodexSubscriptionView {
  /** 行内短文案 */
  label: string;
  /** 悬停说明：写清依据与确认方式 */
  tooltip: string;
  tone: 'muted' | 'success' | 'warning' | 'danger';
  /** 状态未知时需要用户（或系统）刷新额度来确认 */
  needsConfirmation: boolean;
}

export function describeCodexSubscription(subscription: CodexSubscription): CodexSubscriptionView {
  const until = formatDate(subscription.validUntilMs);
  const plan = subscription.planType || '未知套餐';
  const claimNote = `订阅到期 ${until} 来自 OpenAI 登录凭据，只是 OpenAI 上次校验订阅时的快照`
    + (subscription.lastCheckedMs > 0 ? `（校验于 ${formatDate(subscription.lastCheckedMs)}）` : '');
  switch (subscription.status) {
    case 'renewed': {
      const at = formatDateTime(subscription.planConfirmedAtMs);
      return {
        label: `订阅有效 · ${plan}（${at} 确认）`,
        tooltip: `${claimNote}。到期日之后，额度接口于 ${at} 仍返回付费套餐 ${plan}，说明已续费或仍在宽限期内可用。每次刷新额度都会重新确认。`,
        tone: 'success',
        needsConfirmation: false
      };
    }
    case 'lapsed': {
      const at = formatDateTime(subscription.planConfirmedAtMs);
      return {
        label: `订阅已失效（${at} 确认为 free）`,
        tooltip: `${claimNote}。到期日之后，额度接口于 ${at} 返回 free 套餐，订阅已失效。续费后刷新额度即可恢复。`,
        tone: 'danger',
        needsConfirmation: false
      };
    }
    case 'unconfirmed':
      return {
        label: `订阅至 ${until} · 已到期，待确认`,
        tooltip: `${claimNote}。到期日之后还没有新的额度结果，无法判断是否续费。点「确认」会立即刷新额度：返回付费套餐即已续费，返回 free 即已失效。`,
        tone: 'warning',
        needsConfirmation: true
      };
    default:
      return {
        label: `订阅至 ${until}`,
        tooltip: `${claimNote}。`,
        tone: 'muted',
        needsConfirmation: false
      };
  }
}
