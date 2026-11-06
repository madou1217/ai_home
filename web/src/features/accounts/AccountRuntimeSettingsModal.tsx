import { Button, Modal, Tabs } from 'antd';

import type { Account } from '@/types';
import { getAccountPrimaryLabel } from './AccountBadges';
import { canConfigureWindowActivation } from './account-state';
import { AccountEgressModal } from './ZcodeEgressModal';
import { AccountWindowActivationModal } from './AccountWindowActivationModal';
import { AccountAliasPoolModal } from './AccountAliasPoolModal';
import { AccountModelContextModal } from './AccountModelContextModal';
import './account-overlays.css';

interface AccountRuntimeSettingsModalProps {
  account: Account | null;
  /** 该账号当前可服务的模型 id（来自账号模型目录），供上下文窗口面板使用。 */
  models?: readonly string[];
  onClose: () => void;
}

/**
 * 账号的「运行设置」入口：把出口设置、窗口激活、别名选号、上下文窗口合并成一项，
 * 弹窗内用 Tab 切换。这些动作改的都是「这个账号怎么跑」，以前在「更多」子菜单里
 * 一个动作占一行，既扫不完也看不出同类关系。
 */
export function AccountRuntimeSettingsModal({
  account,
  models = [],
  onClose
}: AccountRuntimeSettingsModalProps) {
  const open = Boolean(account);
  const tabs = [
    {
      key: 'egress',
      label: '出口设置',
      children: <AccountEgressModal account={account} onClose={onClose} embedded />
    },
    ...(account && canConfigureWindowActivation(account) ? [{
      key: 'window',
      label: '窗口激活',
      children: <AccountWindowActivationModal account={account} onClose={onClose} embedded />
    }] : []),
    {
      key: 'alias',
      label: '别名选号',
      children: <AccountAliasPoolModal account={account} onClose={onClose} embedded />
    },
    {
      key: 'context',
      label: '上下文窗口',
      children: <AccountModelContextModal account={account} models={models} onClose={onClose} embedded />
    }
  ];
  return (
    <Modal
      title={account ? `运行设置 · ${getAccountPrimaryLabel(account)}` : '运行设置'}
      open={open}
      width={880}
      destroyOnHidden
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      <Tabs items={tabs} />
    </Modal>
  );
}
