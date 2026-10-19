import { useEffect, useState } from 'react';
import { Drawer, Modal, Spin, Tag, message } from 'antd';
import {
  ClockCircleOutlined,
  EyeOutlined,
  ReloadOutlined,
  RollbackOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { providerConfigAPI } from '@/services/api';
import type {
  ProviderConfigHistoryEntry,
  ProviderConfigSaveResponse
} from '@/types';

interface Props {
  open: boolean;
  provider: string;
  fileId: string;
  fileName: string;
  onClose: () => void;
  onRestored: (result: ProviderConfigSaveResponse) => void;
}

const REASON_LABELS: Record<string, string> = {
  baseline: '原始基线',
  save: '保存',
  restore: '恢复'
};

function describeError(error: unknown): string {
  const response = (error as { response?: { data?: { message?: string } } })?.response;
  return response?.data?.message || (error instanceof Error ? error.message : '版本历史读取失败');
}

export default function ProviderConfigHistoryDrawer({
  open,
  provider,
  fileId,
  fileName,
  onClose,
  onRestored
}: Props) {
  const [entries, setEntries] = useState<ProviderConfigHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<ProviderConfigHistoryEntry | null>(null);
  const [selectedContent, setSelectedContent] = useState('');
  const [loadingEntryId, setLoadingEntryId] = useState('');
  const [restoringId, setRestoringId] = useState('');

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError('');
    setSelected(null);
    setSelectedContent('');
    providerConfigAPI.history(provider, fileId)
      .then((result) => {
        if (active) setEntries(result.entries || []);
      })
      .catch((caught) => {
        if (active) setError(describeError(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fileId, open, provider]);

  const preview = async (entry: ProviderConfigHistoryEntry) => {
    setLoadingEntryId(entry.id);
    try {
      const result = await providerConfigAPI.historyEntry(provider, fileId, entry.id);
      setSelected(result.entry);
      setSelectedContent(result.entry.content);
    } catch (caught) {
      message.error(describeError(caught));
    } finally {
      setLoadingEntryId('');
    }
  };

  const restore = (entry: ProviderConfigHistoryEntry) => {
    Modal.confirm({
      title: '恢复到这个版本？',
      content: (
        <div className="pc-confirm-copy">
          <p>当前内容会先进入版本历史，然后文件被替换为 {new Date(entry.savedAt).toLocaleString()} 的版本。</p>
          <p>恢复不会自动重启任何 CLI；正在运行的会话仍使用它启动时读到的配置。</p>
        </div>
      ),
      okText: '恢复',
      cancelText: '取消',
      onOk: async () => {
        setRestoringId(entry.id);
        try {
          const result = await providerConfigAPI.restore(provider, fileId, entry.id);
          message.success('已恢复到选中的版本');
          onRestored(result);
          onClose();
        } catch (caught) {
          message.error(describeError(caught));
        } finally {
          setRestoringId('');
        }
      }
    });
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={560}
      title={`${fileName} 版本历史`}
      className="pc-history-drawer"
      destroyOnClose
    >
      <div className="pc-history-body">
        <p className="pc-history-note">
          历史快照保存在本机 <code>run/provider-config-history/</code>，最多保留 30 条。
          含凭据的文件其历史同样包含凭据，只在本机使用，不会进入导出。
        </p>
        {error && <div className="pc-inline-error" role="alert">{error}</div>}
        {loading ? (
          <div className="pc-loading"><Spin tip="正在读取版本历史" /></div>
        ) : entries.length ? (
          <div className="pc-history-list">
            {entries.map((entry) => (
              <div key={entry.id} className="pc-history-item" data-active={selected?.id === entry.id || undefined}>
                <div className="pc-history-main">
                  <strong>
                    <ClockCircleOutlined /> {new Date(entry.savedAt).toLocaleString()}
                  </strong>
                  <div className="pc-history-meta">
                    <Tag>{REASON_LABELS[entry.reason] || entry.reason}</Tag>
                    <span className="pc-mono">{entry.revision.slice(0, 10)}</span>
                    <span>{Math.max(1, Math.round(entry.size / 1024))} KB</span>
                    {entry.containsSecrets && <Tag color="red">含凭据</Tag>}
                  </div>
                  {entry.note && <p>{entry.note}</p>}
                </div>
                <div className="pc-history-actions">
                  <Button
                    size="small"
                    icon={<EyeOutlined />}
                    loading={loadingEntryId === entry.id}
                    onClick={() => void preview(entry)}
                  >
                    查看
                  </Button>
                  <Button
                    size="small"
                    icon={<RollbackOutlined />}
                    loading={restoringId === entry.id}
                    onClick={() => restore(entry)}
                  >
                    恢复
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="pc-empty-note">
            还没有版本记录。第一次通过这里保存时会先记录原始内容作为基线。
          </div>
        )}
        {selected && (
          <div className="pc-history-preview-wrap">
            <div className="pc-history-preview-head">
              <strong>版本预览</strong>
              <span className="pc-mono">{selected.revision.slice(0, 12)}</span>
            </div>
            <pre className="pc-history-preview">{selectedContent || '（空文件）'}</pre>
          </div>
        )}
        <Button icon={<ReloadOutlined />} onClick={onClose} className="pc-history-close">关闭</Button>
      </div>
    </Drawer>
  );
}
