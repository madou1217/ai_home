import { Button, Input, Modal, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import type { Account, ClientTerminalItem } from '@/types';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';

interface CliPickerModalProps {
  account: Account | null;
  terminals: ClientTerminalItem[];
  selectedTerminalId: string;
  loading: boolean;
  workdir: string;
  workdirHistory: string[];
  onTerminalChange: (terminalId: string) => void;
  onWorkdirChange: (workdir: string) => void;
  onBrowseWorkdir: () => void;
  onClearWorkdirHistory: () => void;
  onCancel: () => void;
  onOpen: (account: Account, terminalId: string, workdir: string) => void;
}

export function CliPickerModal({
  account,
  terminals,
  selectedTerminalId,
  loading,
  workdir,
  workdirHistory,
  onTerminalChange,
  onWorkdirChange,
  onBrowseWorkdir,
  onClearWorkdirHistory,
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
        onOpen(account, selectedTerminalId, workdir.trim());
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
      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 14, marginBottom: 6 }}>
        项目目录
      </Typography.Text>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          readOnly
          value={workdir}
          placeholder="默认：当前用户主目录"
          style={{ background: '#f5f5f5', color: '#595959' }}
        />
        <Button onClick={onBrowseWorkdir}>选择文件夹</Button>
      </Space.Compact>
      {workdirHistory.length > 0 ? (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>最近使用</Typography.Text>
          {workdirHistory.map((item) => (
            <Tag
              key={item}
              title={item}
              onClick={() => onWorkdirChange(item)}
              style={{
                cursor: 'pointer', marginInlineEnd: 0,
                maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis'
              }}
            >
              {item}
            </Tag>
          ))}
          <Popconfirm
            title="清除项目目录历史记录？"
            okText="清除"
            cancelText="取消"
            onConfirm={onClearWorkdirHistory}
          >
            <Typography.Link style={{ fontSize: 12 }}>清除</Typography.Link>
          </Popconfirm>
        </div>
      ) : null}
      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10 }}>
        单击 CLI 图标选择终端与项目目录；双击直接使用系统默认终端。ZCode 仅支持 Desktop，不提供 CLI/TUI。
      </Typography.Text>
    </Modal>
  );
}
