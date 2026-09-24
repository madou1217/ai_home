import type { ReactNode } from 'react';
import { Switch } from 'antd';
import {
  ApiOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  DesktopOutlined,
  GlobalOutlined,
  HistoryOutlined,
  MobileOutlined,
  QrcodeOutlined,
  ReloadOutlined,
  RightOutlined,
  UndoOutlined
} from '@ant-design/icons';
import { DetailSheet, HudIconButton, HudSection, KeyValue } from '@/mobile/ui';
import type { SwipeAction } from '@/mobile/ui';
import { providerNames } from '@/components/chat/ProviderIcon';
import { formatTokenAmount } from '@/components/account/usage-snapshot-format';
import { TOKEN_USAGE_PERIODS } from '@/components/account/token-usage-periods';
import UsageProgressEffects from '@/features/accounts/UsageProgressEffects';
import type { TokenDropEvent } from '@/features/accounts/useTokenDropEvents';
import {
  canCopyAccountEmail,
  canRefreshUsageAccount,
  isAccountEnabled,
  requiresAccountReauth
} from '@/features/accounts/account-state';
import {
  formatPlanValidUntil,
  getAccountDisplayBadgeMeta,
  getAccountPrimaryLabel,
  getAccountRegionMeta,
  getAccountSecondaryLabel,
  getAccountStatusDetailLines,
  getKimiPlanSubscription,
  getPlanTagLabel
} from '@/features/accounts/AccountBadges';
import { getAccountRef } from '@/features/accounts/account-model-catalog';
import {
  canViewQuotaResetHistory,
  getCodexAppAccountActionMeta,
  getDefaultAccountActionMeta
} from '@/features/accounts/account-view-model';
import type { AccountAppSupport } from '@/features/accounts/account-view-model';
import {
  formatCodexResetMenuLabel,
  isCodexOAuthResetEligible
} from '@/features/accounts/codex-reset-credit-model';
import type { AccountActions } from '@/features/accounts/use-account-actions';
import type { Account, ManagementAccountActivity } from '@/types';
import { formatTimeCell } from '@/utils/datetime';
import { badgeStatusTone, ledClass } from './account-tones';
import type { HudTone } from '@/mobile/ui';
import styles from '../MobileAccounts.module.css';

export interface AccountModelProbeView {
  label: string;
  tone: HudTone;
  refreshing: boolean;
}

interface Props {
  record: Account | null;
  onClose: () => void;
  actions: AccountActions;
  /** 行 / 抽屉底部共用的主操作（终端 / 编辑或重新登录 / 删除），与左滑一致 */
  primaryActions: SwipeAction[];
  appSupport: AccountAppSupport | null;
  appEntriesLoaded: boolean;
  desktopRunning: boolean;
  activity: ManagementAccountActivity | null;
  drops: TokenDropEvent[];
  modelProbe: AccountModelProbeView | null;
  onRefreshModels: (record: Account) => void;
}

interface SheetAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}

function formatTime(value?: number | null) {
  const cell = formatTimeCell(value);
  return cell ? `${cell.absolute} · ${cell.relative}` : '-';
}

/**
 * 账号详情抽屉：状态与原因、调度开关、身份与套餐、剩余额度（真实快照窗口）、Token 用量、
 * 模型探测，以及桌面 ⋮ 菜单里的全部账号操作；底部拇指区放与左滑相同的主操作。
 */
export default function AccountDetailSheet({
  record,
  onClose,
  actions,
  primaryActions,
  appSupport,
  appEntriesLoaded,
  desktopRunning,
  activity,
  drops,
  modelProbe,
  onRefreshModels
}: Props) {
  const open = Boolean(record);
  if (!record) {
    return <DetailSheet open={false} onClose={onClose} title="">{null}</DetailSheet>;
  }

  const accountRef = getAccountRef(record);
  const requiresReauth = requiresAccountReauth(record);
  const status = getAccountDisplayBadgeMeta(record);
  const statusTone = badgeStatusTone(status.status);
  const statusDetails = getAccountStatusDetailLines(record);
  const secondary = getAccountSecondaryLabel(record);
  const region = getAccountRegionMeta(record);
  const kimiPlan = getKimiPlanSubscription(record);
  const kimiPlanUntil = kimiPlan ? formatPlanValidUntil(kimiPlan.validUntilMs) : '';
  const refreshingUsage = Boolean(actions.refreshingUsageAccountRefs[accountRef]);
  const updatingStatus = Boolean(actions.updatingStatusAccountRefs[accountRef]);
  const roles = [record.isDefault ? '默认账号' : '', record.isMobile ? 'Codex App 账号' : ''].filter(Boolean).join(' · ');

  // 打开弹窗类操作先收起抽屉，避免两层底部浮层叠加。
  const closeThen = (run: () => void) => () => {
    onClose();
    run();
  };

  const sheetActions: SheetAction[] = [];
  if (!requiresReauth) {
    if (appEntriesLoaded && appSupport?.desktopSupported) {
      sheetActions.push({
        key: 'desktop',
        label: !record.configured
          ? '账号未配置，完成授权后可打开 Desktop'
          : desktopRunning
            ? 'Desktop 运行中（点击关闭）'
            : appSupport.desktopInstalled ? '打开 Desktop' : '未安装 Desktop，点击后确认安装',
        icon: <DesktopOutlined />,
        disabled: !record.configured,
        active: desktopRunning,
        onClick: closeThen(() => {
          if (actions.guardAccountLaunch(record, 'Desktop')) void actions.handleOpenApp(record, 'desktop');
        })
      });
    }
    if (record.provider === 'kimi') {
      sheetActions.push({
        key: 'kimi-desktop-login',
        label: '桌面托管登录（微信扫码）',
        icon: <QrcodeOutlined />,
        onClick: closeThen(() => actions.setKimiDesktopLoginRequest({ account: record, openAfterLogin: false }))
      });
    }
    const defaultAction = getDefaultAccountActionMeta(record);
    sheetActions.push({
      key: 'set-default',
      label: defaultAction.label,
      icon: <CheckCircleOutlined />,
      disabled: defaultAction.disabled,
      active: defaultAction.active,
      onClick: () => { void actions.handleSetDefault(record); }
    });
    const codexAppAction = getCodexAppAccountActionMeta(record);
    if (codexAppAction) {
      sheetActions.push({
        key: 'set-mobile',
        label: codexAppAction.label,
        icon: <MobileOutlined />,
        disabled: codexAppAction.disabled,
        active: codexAppAction.active,
        onClick: () => { void actions.handleSetMobile(record); }
      });
    }
    if (isCodexOAuthResetEligible(record)) {
      sheetActions.push({
        key: 'codex-reset-credits',
        label: formatCodexResetMenuLabel(record),
        icon: <UndoOutlined />,
        onClick: closeThen(() => actions.setCodexResetAccount(record))
      });
    }
    if (canViewQuotaResetHistory(record)) {
      sheetActions.push({
        key: 'quota-reset-history',
        label: '重置历史记录',
        icon: <HistoryOutlined />,
        onClick: closeThen(() => actions.setQuotaResetHistoryAccount(record))
      });
    }
    sheetActions.push({
      key: 'account-egress',
      label: '出口设置',
      icon: <GlobalOutlined />,
      onClick: closeThen(() => actions.setAccountEgressAccount(record))
    });
  }

  const tokenUsage = record.tokenUsage;
  const identityRows = [
    {
      key: 'identity',
      label: '账号',
      value: (
        <span className={styles.identity}>
          <span className={styles.identityText}>{getAccountPrimaryLabel(record)}</span>
          {canCopyAccountEmail(record) ? (
            <button
              type="button"
              className={styles.inlineIconBtn}
              aria-label="复制账号"
              onClick={() => { void actions.copyAccountEmail(record); }}
            >
              <CopyOutlined />
            </button>
          ) : null}
        </span>
      )
    },
    ...(secondary ? [{ key: 'secondary', label: '标识', value: secondary }] : []),
    { key: 'provider', label: '平台', value: providerNames[record.provider] || record.provider, mono: false },
    {
      key: 'plan',
      label: '套餐',
      value: kimiPlan && kimiPlanUntil
        ? `${kimiPlan.name || getPlanTagLabel(record)} · ${kimiPlanUntil}${kimiPlan.status === 'canceled' ? ' · 已取消续费' : ''}`
        : getPlanTagLabel(record)
    },
    ...(region ? [{ key: 'region', label: '区域', value: region.endpoint ? `${region.label} · ${region.endpoint}` : region.label, mono: false }] : []),
    ...(roles ? [{ key: 'roles', label: '角色', value: roles, mono: false }] : []),
    {
      key: 'configured',
      label: '配置状态',
      value: record.configured ? '已配置' : '未配置',
      tone: (record.configured ? 'ok' : 'muted') as HudTone,
      mono: false
    },
    ...(desktopRunning ? [{ key: 'desktop', label: 'Desktop', value: '运行中', tone: 'ok' as HudTone, mono: false }] : []),
    { key: 'updatedAt', label: '额度更新', value: formatTime(record.updatedAt) },
    { key: 'lastUsedAt', label: '上次成功使用', value: formatTime(record.lastUsedAt) }
  ];

  const footer = primaryActions.length > 0 ? (
    <div className={styles.sheetFooter}>
      {primaryActions.map((action) => (
        <HudIconButton
          key={action.key}
          icon={action.icon}
          label={action.label}
          showLabel
          tone={action.tone}
          disabled={action.disabled}
          onClick={closeThen(action.onAction)}
        />
      ))}
    </div>
  ) : undefined;

  return (
    <DetailSheet
      open={open}
      onClose={onClose}
      code={`ACCT // ${String(record.provider).toUpperCase()}`}
      title={getAccountPrimaryLabel(record)}
      footer={footer}
    >
      <div className={styles.sheetStack}>
        <div className={styles.statusBlock}>
          <div className={styles.statusLine}>
            <span className={`mhud-status mhud-tone--${statusTone}`}>
              <span className={ledClass(statusTone)} aria-hidden="true" />
              {status.label}
            </span>
            <label className={styles.switchLabel}>
              <span>调度</span>
              <Switch
                checked={isAccountEnabled(record)}
                checkedChildren="启用"
                unCheckedChildren="关闭"
                loading={updatingStatus}
                disabled={requiresReauth}
                onChange={(checked) => { void actions.handleToggleStatus(record, checked); }}
              />
            </label>
          </div>
          {statusDetails.map((line) => (
            <p key={line} className={styles.statusDetail}>{line}</p>
          ))}
        </div>

        <KeyValue rows={identityRows} />

        <HudSection
          title="剩余额度"
          code="QUOTA"
          extra={canRefreshUsageAccount(record) ? (
            <HudIconButton
              icon={<ReloadOutlined />}
              label="刷新当前账号状态"
              loading={refreshingUsage}
              onClick={() => { void actions.handleRefreshUsage(record); }}
            />
          ) : null}
        >
          <div className={styles.quotaPanel}>
            <UsageProgressEffects record={record} activity={activity} drops={drops} />
          </div>
        </HudSection>

        <HudSection title="Token 用量" code="TOKENS">
          {tokenUsage ? (
            <KeyValue
              rows={TOKEN_USAGE_PERIODS.map((period) => ({
                key: period.key,
                label: period.hint,
                value: formatTokenAmount(Number(tokenUsage[period.key]) || 0)
              }))}
            />
          ) : (
            <p className={styles.muted}>暂无统计</p>
          )}
        </HudSection>

        {modelProbe ? (
          <HudSection title="模型探测" code="MODELS">
            <div className={styles.probeLine}>
              <span className={`mhud-status mhud-tone--${modelProbe.tone}`}>
                <span className={ledClass(modelProbe.tone, modelProbe.refreshing)} aria-hidden="true" />
                {modelProbe.label}
              </span>
              <span className={styles.probeActions}>
                <HudIconButton
                  icon={<ReloadOutlined />}
                  label="刷新该账号模型目录"
                  loading={modelProbe.refreshing}
                  disabled={requiresReauth}
                  onClick={() => onRefreshModels(record)}
                />
                <HudIconButton
                  icon={<ApiOutlined />}
                  label="模型管理"
                  showLabel
                  disabled={requiresReauth}
                  onClick={closeThen(() => actions.openModelManagement(record))}
                />
              </span>
            </div>
          </HudSection>
        ) : null}

        {sheetActions.length > 0 ? (
          <HudSection title="账号操作" code="OPS">
            <div className={styles.actionList} role="list">
              {sheetActions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  role="listitem"
                  className={`${styles.actionItem}${action.active ? ` ${styles.actionItemActive}` : ''}`}
                  disabled={action.disabled}
                  onClick={action.onClick}
                >
                  <span className={styles.actionIcon} aria-hidden="true">{action.icon}</span>
                  <span className={styles.actionLabel}>{action.label}</span>
                  <RightOutlined className={styles.actionArrow} aria-hidden="true" />
                </button>
              ))}
            </div>
          </HudSection>
        ) : null}
      </div>
    </DetailSheet>
  );
}
