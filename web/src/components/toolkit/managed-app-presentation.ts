import type { Account, ManagedAppItem } from '@/types';
import { SESSION_SYNC_SUMMARY } from '@/components/session-sync-copy';

export const SYNC_MODE_LABELS: Record<ManagedAppItem['syncMode'], string> = {
  hook: '即时通知',
  polling: '定时检查',
  unavailable: '不可读取'
};

export const SYNC_MODE_DESCRIPTIONS: Record<ManagedAppItem['syncMode'], string> = {
  hook: `${SESSION_SYNC_SUMMARY} 当前使用即时通知，新回合后可立即刷新。`,
  polling: `${SESSION_SYNC_SUMMARY} 当前定时检查会话文件，可能有轻微延迟。`,
  unavailable: '当前 Provider 没有可读取的本地会话文件。'
};

const HOOK_REASON_LABELS: Record<string, string> = {
  disabled: '即时刷新已禁用',
  missing_events: '即时刷新配置不完整'
};

export function hasExistingAppConfig(app: ManagedAppItem) {
  return Boolean(app.configExists && app.configName);
}

export function getAppHookStatusDetail(app: ManagedAppItem) {
  if (!app.hookSupported || app.hookInstalled) return '';
  const reasonKey = String(app.hookReason || '').trim();
  const reason = HOOK_REASON_LABELS[reasonKey]
    || (reasonKey ? `即时刷新状态：${reasonKey}` : '即时刷新尚未通过验证');
  const missingEvents = (app.hookMissingEvents || [])
    .map((event) => String(event || '').trim())
    .filter(Boolean);
  return [
    reason,
    missingEvents.length > 0 ? `缺少事件：${missingEvents.join('、')}` : ''
  ].filter(Boolean).join('；');
}

/** 应用卡上的「当前版本」读数：未安装 / 未探测到 / 实测版本。 */
export function getAppCurrentVersion(app: ManagedAppItem) {
  return app.installed
    ? (app.version && app.version !== '-' ? app.version : '未探测到')
    : '未安装';
}

export function managedAppAccountLabel(account: Account) {
  return String(account.displayName || account.email || account.accountRef || '未命名账号').trim();
}

export function managedAppAccountIsRunning(account: Account, runningPids: Record<string, number[]>) {
  return Array.isArray(runningPids[account.accountRef])
    && runningPids[account.accountRef].length > 0;
}

/** 同 Provider 账号：默认账号在前，其余按显示名排序。 */
export function sortManagedAppAccounts(accounts: Account[], provider: string) {
  return accounts
    .filter((account) => account.provider === provider)
    .sort((left, right) => {
      if (Boolean(left.isDefault) !== Boolean(right.isDefault)) return left.isDefault ? -1 : 1;
      return managedAppAccountLabel(left).localeCompare(managedAppAccountLabel(right), 'zh-CN');
    });
}
