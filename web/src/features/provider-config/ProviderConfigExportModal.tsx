import { writeClipboardText } from '@/utils/clipboard';
import { useEffect, useState } from 'react';
import { Modal, Segmented, Spin, Tag, message } from 'antd';
import {
  CopyOutlined,
  DownloadOutlined,
  SafetyCertificateOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { providerConfigAPI } from '@/services/api';
import type { ProviderConfigExportResponse } from '@/types';

interface Props {
  open: boolean;
  provider: string;
  fileId: string;
  fileName: string;
  sensitive: boolean;
  onClose: () => void;
}

function describeError(error: unknown): string {
  const response = (error as { response?: { data?: { message?: string } } })?.response;
  return response?.data?.message || (error instanceof Error ? error.message : '导出失败');
}

async function copyText(text: string): Promise<boolean> {
  try {
    await writeClipboardText(text);
    return true;
  } catch (_error) {
    return false;
  }
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export default function ProviderConfigExportModal({
  open,
  provider,
  fileId,
  fileName,
  sensitive,
  onClose
}: Props) {
  const [mode, setMode] = useState<'redacted' | 'raw'>('redacted');
  const [data, setData] = useState<ProviderConfigExportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError('');
    providerConfigAPI.exportFile(provider, fileId, mode)
      .then((result) => {
        if (active) setData(result);
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
  }, [fileId, mode, open, provider]);

  const copy = async () => {
    if (!data) return;
    const ok = await copyText(data.content);
    if (ok) message.success('已复制到剪贴板');
    else message.error('复制失败，请手动选择文本');
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={860}
      title={`导出 ${fileName}`}
      destroyOnClose
      footer={(
        <div className="pc-modal-footer">
          <Button onClick={onClose}>关闭</Button>
          <Button icon={<DownloadOutlined />} disabled={!data} onClick={() => {
            if (data) downloadText(data.filename, data.content);
          }}>
            下载文件
          </Button>
          <Button type="primary" icon={<CopyOutlined />} disabled={!data} onClick={() => void copy()}>
            复制内容
          </Button>
        </div>
      )}
    >
      <div className="pc-export">
        <div className="pc-export-toolbar">
          <Segmented
            value={mode}
            onChange={(value) => setMode(value as 'redacted' | 'raw')}
            options={[
              { label: '脱敏模板', value: 'redacted' },
              { label: '原文件', value: 'raw' }
            ]}
          />
          {data && (
            <div className="pc-export-meta">
              <Tag>{data.filename}</Tag>
              {data.mode === 'redacted' && (
                <Tag color="green">
                  <SafetyCertificateOutlined /> 已处理 {data.redactedFields.length} 个敏感字段
                </Tag>
              )}
              {data.mode === 'raw' && data.sensitive && <Tag color="red">含凭据</Tag>}
            </div>
          )}
        </div>

        {mode === 'raw' ? (
          <div className="pc-inspector-note" data-tone={sensitive ? 'warning' : 'neutral'}>
            <SafetyCertificateOutlined />
            <span>
              原文件会逐字节导出。{sensitive ? '该文件被标记为包含凭据，请只发送给可信对象。' : '发送前请自行确认是否包含私有地址或密钥。'}
            </span>
          </div>
        ) : (
          <p className="pc-export-hint">
            脱敏模板保留键结构与注释可读性，按字段说明里的 <code>secret</code> 标记和常见密钥键名替换值；
            无法解析的文件会退化为逐行脱敏。
          </p>
        )}

        {error && <div className="pc-inline-error" role="alert">{error}</div>}
        {loading ? (
          <div className="pc-loading"><Spin tip="正在生成导出内容" /></div>
        ) : (
          <pre className="pc-export-preview">{data?.content || ''}</pre>
        )}
        {data && data.mode === 'redacted' && data.redactedFields.length > 0 && (
          <div className="pc-export-fields">
            <span>已脱敏：</span>
            {data.redactedFields.slice(0, 24).map((field) => (
              <code key={field}>{field}</code>
            ))}
            {data.redactedFields.length > 24 && <span>等 {data.redactedFields.length} 项</span>}
          </div>
        )}
      </div>
    </Modal>
  );
}
