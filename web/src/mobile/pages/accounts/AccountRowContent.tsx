import { providerNames } from '@/components/chat/ProviderIcon';
import AccountActivityIcon from '@/features/accounts/AccountActivityIcon';
import {
  getAccountDisplayBadgeMeta,
  getAccountPrimaryLabel,
  getPlanTagLabel
} from '@/features/accounts/AccountBadges';
import { getAccountRef } from '@/features/accounts/account-model-catalog';
import { getEffectiveRemainingPct } from '@/features/accounts/account-state';
import type { Account, ManagementAccountActivity } from '@/types';
import { badgeStatusTone, ledClass, remainingTone } from './account-tones';
import styles from '../MobileAccounts.module.css';

interface Props {
  record: Account;
  activity: ManagementAccountActivity | null;
  removing: boolean;
  desktopRunning: boolean;
}

/**
 * 账号行（SwipeRow 内容）：Provider 活动图标 + 身份（与桌面同一脱敏标签）+ 平台 / 套餐 / 角色，
 * 右侧状态 LED + 短标签与剩余额度细轨。其余字段在点按后的详情抽屉里。
 */
export default function AccountRowContent({ record, activity, removing, desktopRunning }: Props) {
  const status = getAccountDisplayBadgeMeta(record);
  const statusTone = badgeStatusTone(status.status);
  const remaining = record.apiKeyMode ? null : getEffectiveRemainingPct(record);
  const meta = [
    providerNames[record.provider] || record.provider,
    getPlanTagLabel(record),
    record.isDefault ? '默认' : '',
    record.isMobile ? 'APP' : '',
    desktopRunning ? 'DESKTOP' : ''
  ].filter(Boolean).join(' · ');

  return (
    <div
      className={`${styles.row}${removing ? ` ${styles.rowRemoving}` : ''}`}
      data-account-ref={getAccountRef(record)}
    >
      <span className="mhud-row__icon" aria-hidden="true">
        <AccountActivityIcon provider={record.provider} activity={activity} size={20} />
      </span>
      <span className="mhud-row__main">
        <span className="mhud-row__title">{getAccountPrimaryLabel(record)}</span>
        <span className="mhud-row__meta">{meta}</span>
      </span>
      <span className="mhud-row__side">
        <span className={`mhud-status mhud-tone--${statusTone}`}>
          <span className={ledClass(statusTone)} aria-hidden="true" />
          {status.label}
        </span>
        {remaining != null ? (
          <span className={styles.quota}>
            <span className={`mhud-tone--${remainingTone(remaining)}`}>{remaining.toFixed(0)}%</span>
            <span className={`mhud-track ${styles.quotaTrack}`} aria-hidden="true">
              <span
                className={`mhud-track__fill mhud-bg--${remainingTone(remaining)}`}
                style={{ width: `${Math.max(0, Math.min(100, remaining))}%` }}
              />
            </span>
          </span>
        ) : (
          <span className={styles.quotaNone} title={record.apiKeyMode ? '额度由上游管理' : '额度未知'}>—</span>
        )}
      </span>
    </div>
  );
}
