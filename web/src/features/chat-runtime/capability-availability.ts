import type { SessionProjection } from '@/chat-runtime';
import type { ApprovalMode } from './session-surface-policy';

export type ApprovalAvailability = Readonly<Partial<Record<ApprovalMode, string>>>;

// 能力快照 → 不可用的审批模式及原因。快照缺失（会话还没起来）时一律视为可用，交给服务端兜底。
const APPROVAL_REASON_COPY: Readonly<Record<string, string>> = {
  zcode_desktop_approval_requires_desktop: 'ZCode 的逐项确认由 Desktop 处理，请在 Desktop 中确认',
  agy_cli_has_no_permission_channel: 'Antigravity CLI 没有权限确认通道',
  grok_acp_unverified_no_account: 'Grok 的审批通道待接入',
};

export function approvalAvailabilityFrom(capabilities: SessionProjection['capabilitySnapshot']): ApprovalAvailability {
  const entries = capabilities?.capabilities;
  if (!entries) return {};
  const reasonFor = (name: 'interaction.approval' | 'mode.plan'): string | undefined => {
    const descriptor = entries[name];
    if (!descriptor || descriptor.support !== 'unsupported') return undefined;
    return APPROVAL_REASON_COPY[descriptor.reason || ''] || '当前 CLI 不支持此模式';
  };
  const confirm = reasonFor('interaction.approval');
  const plan = reasonFor('mode.plan');
  return { ...(confirm ? { confirm } : {}), ...(plan ? { plan } : {}) };
}
