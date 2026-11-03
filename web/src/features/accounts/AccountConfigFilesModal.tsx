import { useCallback, useEffect, useMemo, useState } from 'react';
import { Empty, Modal, Segmented, Spin, Tabs, Tooltip, Typography, message } from 'antd';
import { CopyOutlined, EyeInvisibleOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import type { Account, AccountConfigFile, AccountConfigFilesResponse } from '@/types';
import { accountsAPI } from '@/services/api';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import ConfigCodeEditor from '@/components/toolkit/config-editor/ConfigCodeEditor';

const { Text } = Typography;

interface AccountConfigFilesModalProps {
  account: Account | null;
  onClose: () => void;
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
 * 账号配置文件只读查看：复用 toolkit 的 ConfigCodeEditor（只读模式）。
 * 文件列表完全由服务端声明（凭据记录、解码后的凭据库、运行时投影文件），前端不认 provider。
 * 默认脱敏；「显示原文」需要二次确认。
 */
export default function AccountConfigFilesModal({ account, onClose }: AccountConfigFilesModalProps) {
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
    <Modal
      open={Boolean(account)}
      onCancel={onClose}
      width={1000}
      title={account ? `${account.displayName || accountRef} 账号配置` : '账号配置'}
      footer={(
        <div className="toolkit-header-actions">
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(mode)}>刷新</Button>
          <Button icon={<CopyOutlined />} disabled={!selected} onClick={() => void copySelected()}>复制当前文件</Button>
          <Button type="primary" onClick={onClose}>关闭</Button>
        </div>
      )}
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
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
    </Modal>
  );
}
