import { useEffect, useState } from 'react';
import { Button, Modal, Tabs } from 'antd';

import type { Account } from '@/types';
import { getAccountPrimaryLabel } from './AccountBadges';
import { canViewQuotaResetHistory } from './account-view-model';
import { isCodexOAuthResetEligible } from './codex-reset-credit-model';
import { CodexResetCreditsPanel } from './CodexResetCreditsPanel';
import { AccountQuotaResetHistoryPanel } from './AccountQuotaResetHistoryPanel';

/**
 * 账号的「重置」入口：把原来菜单里的「重置额度」和「重置历史记录」合成一项，
 * 弹窗内用 Tab 切换。只具备其中一种能力时直接渲染对应面板，不摆单 Tab 的空壳。
 */
interface AccountResetModalProps {
  account: Account | null;
  onClose: () => void;
  onAvailableCountChange: (accountRef: string, availableCount: number) => void;
}

type ResetTab = 'credits' | 'history';

export function AccountResetModal({
  account,
  onClose,
  onAvailableCountChange
}: AccountResetModalProps) {
  const open = Boolean(account);
  const canResetCredits = account ? isCodexOAuthResetEligible(account) : false;
  const canViewHistory = account ? canViewQuotaResetHistory(account) : false;
  const showTabs = canResetCredits && canViewHistory;
  const [tab, setTab] = useState<ResetTab>('credits');
  const [busy, setBusy] = useState(false);

  // 换账号或重新打开时回到该账号有的那个 Tab，并解除上一次操作留下的关闭锁。
  useEffect(() => {
    setBusy(false);
    setTab(canResetCredits ? 'credits' : 'history');
  }, [account?.accountRef, canResetCredits]);

  if (!account) return null;

  // 重置/核对进行中不允许关闭：卸载面板会丢掉轮询，账号会停在「结果待确认」。
  const closeAllowed = !busy;
  const handleClose = () => {
    if (closeAllowed) onClose();
  };
  const label = getAccountPrimaryLabel(account);

  // 面板的 active 只看弹窗是否打开，不看当前 Tab：切到历史时重置轮询不能停。
  const creditsPanel = (
    <CodexResetCreditsPanel
      account={account}
      active={open}
      onClose={handleClose}
      onAvailableCountChange={onAvailableCountChange}
      onBusyChange={setBusy}
    />
  );
  const historyPanel = <AccountQuotaResetHistoryPanel account={account} active={open} />;

  return (
    <Modal
      title={`重置 · ${label}`}
      open={open}
      width={showTabs ? 720 : 600}
      destroyOnHidden
      closable={closeAllowed}
      maskClosable={closeAllowed}
      keyboard={closeAllowed}
      onCancel={handleClose}
      footer={(
        <Button onClick={handleClose} disabled={!closeAllowed}>
          关闭
        </Button>
      )}
    >
      {showTabs ? (
        <Tabs
          activeKey={tab}
          onChange={(key) => setTab(key as ResetTab)}
          items={[
            { key: 'credits', label: '重置额度', children: creditsPanel },
            { key: 'history', label: '重置历史', children: historyPanel }
          ]}
        />
      ) : canResetCredits ? creditsPanel : historyPanel}
    </Modal>
  );
}
