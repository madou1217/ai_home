import { Modal, Select, Typography } from 'antd';
import type { Account, ClientTerminalItem } from '@/types';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';

interface CliPickerModalProps {
  account: Account | null;
  terminals: ClientTerminalItem[];
  selectedTerminalId: string;
  loading: boolean;
  onTerminalChange: (terminalId: string) => void;
  onCancel: () => void;
  onOpen: (account: Account, terminalId: string) => void;
}

export function CliPickerModal({
  account,
  terminals,
  selectedTerminalId,
  loading,
  onTerminalChange,
  onCancel,
  onOpen
}: CliPickerModalProps) {
  return (
    <Modal
      open={Boolean(account)}
      title={account ? `选择终端 · ${getAccountPrimaryLabel(account)}` : '选择终端'}
      okText="打开 CLI"
      cancelText="取消"
      confirmLoading={loading}
      onCancel={onCancel}
      onOk={() => {
        if (!account) return;
        onOpen(account, selectedTerminalId);
      }}
    >
      <Select
        style={{ width: '100%' }}
        value={selectedTerminalId}
        onChange={onTerminalChange}
        options={terminals.map((terminal) => ({
          value: terminal.id,
          label: `${terminal.name}${terminal.default ? '（系统默认）' : ''}`,
          title: terminal.description
        }))}
      />
      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10 }}>
        单击 CLI 图标选择终端；双击直接使用系统默认终端。ZCode 仅支持 Desktop，不提供 CLI/TUI。
      </Typography.Text>
    </Modal>
  );
}