import { useCallback, useEffect, useMemo, useState } from 'react';
import { Empty, Modal, Segmented, Spin, Tabs, Tooltip, Typography, message } from 'antd';
import { CodeOutlined, CopyOutlined, EyeInvisibleOutlined, EyeOutlined, ExportOutlined, ReloadOutlined } from '@ant-design/icons';
import type { Account, AccountConfigFile, AccountConfigFilesResponse } from '@/types';
import { accountsAPI } from '@/services/api';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import ConfigCodeEditor from '@/components/toolkit/config-editor/ConfigCodeEditor';
import { buildAccountCliCommand } from '@/features/accounts/account-cli-command';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';
import { writeClipboardText } from '@/utils/clipboard';

const { Text } = Typography;

interface AccountConfigFilesModalProps {
  account: Account | null;
  onClose: () => void;
  onExport?: () => void;
  exporting?: boolean;
}

interface AccountConfigFilesPanelProps {
  account: Account | null;
  /** 有值才显示「导出账号」：配置文件与导出都是「把这台账号的设置拿走」，放在同一个面板里。 */
  onExport?: () => void;
  exporting?: boolean;
}

// tab 标题用文件名（codex 的 auth.json / config.toml 一眼可辨），完整位置放 tooltip。
function tabTitle(file: AccountConfigFile) {
  if (file.source === 'store') return file.label;
  return file.label.split('/').pop() || file.label;
}

function formatTime(ms: number) {
  return ms ? new Date(ms).toLocaleString() : '';
}

/**
 * 账号配置文件只读查看 + 导出。文件列表完全由服务端声明（凭据记录、解码后的凭据库、
 * 运行时投影文件），前端不认 provider。默认脱敏；「显示原文」需要二次确认。
 *
 * 单独抽成 Panel，是为了既能独立成弹窗（OAuth 账号），也能作为「账号配置」弹窗里的
 * 一个 Tab（API Key 账号与编辑表单合并）。
 */
export function AccountConfigFilesPanel({ account, onExport, exporting }: AccountConfigFilesPanelProps) {
  const [mode, setMode] = useState<'redacted' | 'raw'>('redacted');
  const [data, setData] = useState<AccountConfigFilesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const provider = account?.provider || '';
  const accountRef = account?.accountRef || '';

  const load = useCallback(async (nextMode: 'redacted' | 'raw') => {
    if (!provider || !accountRef) return;
    setLoading(true);
    setError('');
    try {
      const result = await accountsAPI.getAccountConfigFiles(provider, accountRef, nextMode);
      setData(result);
      setSelectedId((current) => (
        result.files.some((file) => file.id === current) ? current : (result.files[0]?.id || '')
      ));
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || '读取账号配置失败');
    } finally {
      setLoading(false);
    }
  }, [provider, accountRef]);

  useEffect(() => {
    if (!account) {
      setData(null);
      setMode('redacted');
      setSelectedId('');
      setError('');
      return;
    }
    void load('redacted');
  }, [account, load]);

  const switchMode = (nextMode: 'redacted' | 'raw') => {
    if (nextMode === mode) return;
    if (nextMode === 'raw') {
      Modal.confirm({
        title: '显示原文？',
        content: '原文包含 access token、refresh token、client secret 等凭据，请确认周围无人旁观且不要截图外传。',
        okText: '显示原文',
        cancelText: '取消',
        onOk: () => {
          setMode('raw');
          void load('raw');
        }
      });
      return;
    }
    setMode('redacted');
    void load('redacted');
  };

  const selected = useMemo(
    () => data?.files.find((file) => file.id === selectedId) || null,
    [data, selectedId]
  );

  const cliCommand = buildAccountCliCommand(account);
  const copyCliCommand = async () => {
    if (!cliCommand) return;
    try {
      await writeClipboardText(cliCommand);
      message.success(`已复制：${cliCommand}`);
    } catch {
      message.error('复制失败');
    }
  };

  const copySelected = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.content);
      message.success('已复制');
    } catch {
      message.error('复制失败');
    }
  };

  return (
    <>
      <div className="account-config-toolbar">
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => void load(mode)}
        >
          刷新
        </Button>
        <Button icon={<CopyOutlined />} disabled={!selected} onClick={() => void copySelected()}>
          复制当前文件
        </Button>
        {cliCommand ? (
          <Tooltip title={cliCommand}>
            <Button icon={<CodeOutlined />} onClick={() => void copyCliCommand()}>
              复制启动命令
            </Button>
          </Tooltip>
        ) : null}
        {onExport ? (
          <Button icon={<ExportOutlined />} loading={exporting} onClick={onExport}>
            导出账号
          </Button>
        ) : null}
        <Segmented
          value={mode}
          onChange={(value) => switchMode(value as 'redacted' | 'raw')}
          options={[
            { value: 'redacted', label: '脱敏', icon: <EyeInvisibleOutlined /> },
            { value: 'raw', label: '原文', icon: <EyeOutlined /> }
          ]}
        />
      </div>
      {data && data.files.length > 0 ? (
        <Tabs
          activeKey={selectedId}
          onChange={setSelectedId}
          size="small"
          items={data.files.map((file) => ({
            key: file.id,
            label: <Tooltip title={file.location}><span>{tabTitle(file)}</span></Tooltip>
          }))}
        />
      ) : null}
      {error ? <InlineNote tone="warning">{error}</InlineNote> : null}
      {loading && !data ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在读取账号配置" /></div>
      ) : !data || data.files.length === 0 ? (
        <Empty description="该账号没有可查看的配置文件" />
      ) : selected ? (
        <>
          <p className="toolkit-section-note">
            <Text type="secondary">{selected.location}</Text>
            {selected.updatedAt ? <Text type="secondary"> · 更新于 {formatTime(selected.updatedAt)}</Text> : null}
            {mode === 'redacted' && selected.redactedFields.length > 0
              ? <Text type="secondary"> · 已脱敏 {selected.redactedFields.length} 个字段</Text>
              : null}
          </p>
          {mode === 'raw' ? (
            <InlineNote tone="warning">当前显示原文，包含账号凭据。</InlineNote>
          ) : null}
          <Spin spinning={loading}>
            <ConfigCodeEditor
              value={selected.content}
              onChange={() => undefined}
              format={selected.format}
              fileName={selected.label.split('/').pop()}
              ariaLabel={`${selected.label} 内容`}
              readOnly
            />
          </Spin>
        </>
      ) : null}
    </>
  );
}

/**
 * 账号配置只读弹窗：OAuth 账号没有编辑表单，但仍可查看与导出配置。
 * API Key 账号在「编辑配置」弹窗里用同一个 Panel 作为 Tab，菜单不再为「查看配置文件」
 * 和「导出账号」各留一行。
 */
export default function AccountConfigFilesModal({ account, onClose, onExport, exporting }: AccountConfigFilesModalProps) {
  return (
    <Modal
      open={Boolean(account)}
      onCancel={onClose}
      width={1000}
      title={account ? `${getAccountPrimaryLabel(account)} 账号配置` : '账号配置'}
      footer={<Button type="primary" onClick={onClose}>关闭</Button>}
    >
      <AccountConfigFilesPanel account={account} onExport={onExport} exporting={exporting} />
    </Modal>
  );
}
