import { Button, Input, Modal, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import type { Account, ClientTerminalItem } from '@/types';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';
import './account-overlays.css';

interface CliPickerModalProps {
  account: Account | null;
  terminals: ClientTerminalItem[];
  selectedTerminalId: string;
  loading: boolean;
  workdir: string;
  workdirHistory: string[];
  harnesses: Array<{ id: string; label: string }>;
  selectedHarness: string;
  models: string[];
  modelLabels: Record<string, string>;
  selectedModel: string;
  serverRuntime?: boolean;
  onHarnessChange: (harness: string) => void;
  onModelChange: (model: string) => void;
  onTerminalChange: (terminalId: string) => void;
  onWorkdirChange: (workdir: string) => void;
  onBrowseWorkdir: () => void;
  onClearWorkdirHistory: () => void;
  onCancel: () => void;
  onOpen: (account: Account, terminalId: string, workdir: string, harness: string, model: string) => void;
}

export function CliPickerModal({
  account,
  terminals,
  selectedTerminalId,
  loading,
  workdir,
  workdirHistory,
  harnesses,
  selectedHarness,
  models,
  modelLabels,
  selectedModel,
  serverRuntime = false,
  onHarnessChange,
  onModelChange,
  onTerminalChange,
  onWorkdirChange,
  onBrowseWorkdir,
  onClearWorkdirHistory,
  onCancel,
  onOpen
}: CliPickerModalProps) {
  const crossProvider = Boolean(account && selectedHarness && selectedHarness !== account.provider);
  const canOpen = Boolean(selectedHarness) && (!crossProvider || Boolean(selectedModel));
  const modelOptions = models.map((model) => {
    const label = String(modelLabels[model] || '').trim();
    return {
      value: model,
      label: label && label !== model ? `${model} · ${label}` : model,
      title: label || model
    };
  });
  return (
    <Modal
      open={Boolean(account)}
      title={account ? `打开 CLI · ${getAccountPrimaryLabel(account)}` : '打开 CLI'}
      okText="打开 CLI"
      cancelText="取消"
      confirmLoading={loading}
      okButtonProps={{ disabled: !canOpen }}
      onCancel={onCancel}
      onOk={() => {
        if (!account || !canOpen) return;
        onOpen(account, selectedTerminalId, workdir.trim(), selectedHarness, selectedModel);
      }}
    >
      <span className="hud-label cli-picker-caption">Harness</span>
      <Select
        style={{ width: '100%' }}
        value={selectedHarness || undefined}
        onChange={onHarnessChange}
        placeholder="选择运行该账号的 CLI"
        options={harnesses.map((harness) => ({
          value: harness.id,
          label: harness.label
        }))}
      />
      <span className="hud-label cli-picker-caption">身份</span>
      <Select
        style={{ width: '100%' }}
        value={account?.provider}
        disabled
        options={account ? [{
          value: account.provider,
          label: `${getAccountPrimaryLabel(account)} · ${account.provider}`
        }] : []}
      />
      <span className="hud-label cli-picker-caption">模型</span>
      <Select
        style={{ width: '100%' }}
        value={selectedModel || undefined}
        onChange={(value) => onModelChange(String(value || ''))}
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder={crossProvider ? '跨 Provider 必须选择身份账号支持的模型' : '跟随 harness 默认'}
        options={modelOptions}
        notFoundContent={loading ? '正在读取模型…' : '账号模型目录为空，请先在账号页刷新模型'}
      />
      {crossProvider && !selectedModel ? (
        <Typography.Text type="warning" className="aih-overlay-hint cli-picker-hint">
          跨 Provider 启动不会使用 harness 自己的默认模型；请选择上方的身份账号模型。
        </Typography.Text>
      ) : null}
      {serverRuntime ? (
        <Typography.Text type="secondary" className="aih-overlay-hint cli-picker-hint">
          当前连接的是 Server，CLI 将在 Server 的 Web 虚拟终端中运行；浏览器刷新后仍可重新打开。
        </Typography.Text>
      ) : (
        <>
          <span className="hud-label cli-picker-caption">终端</span>
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
        </>
      )}
      <span className="hud-label cli-picker-caption">项目目录</span>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          readOnly
          value={workdir}
          placeholder="默认：当前用户主目录"
          className="cli-picker-workdir"
        />
        <Button onClick={onBrowseWorkdir}>选择文件夹</Button>
      </Space.Compact>
      {workdirHistory.length > 0 ? (
        <div className="cli-picker-history">
          <span className="hud-label">最近使用</span>
          {workdirHistory.map((item) => (
            <Tag
              key={item}
              title={item}
              className="cli-picker-history-chip"
              onClick={() => onWorkdirChange(item)}
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
            <Typography.Link className="cli-picker-clear">清除</Typography.Link>
          </Popconfirm>
        </div>
      ) : null}
      <Typography.Text type="secondary" className="aih-overlay-hint cli-picker-hint">
        账号身份固定为当前行；换 harness 不改身份，只会经本地网关转发。双击 CLI 图标仍直接用原生 harness 打开。
      </Typography.Text>
    </Modal>
  );
}
