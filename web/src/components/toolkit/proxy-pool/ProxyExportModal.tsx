import { Alert, Modal, Radio, Space, Spin, Tag, Typography, message } from 'antd';
import { CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '@/components/ui/AppButton';
import { proxyPoolAPI } from '@/services/api';
import type { AggregateExportResponse } from '@/types';
import { copyText, getErrorMessage } from './proxy-pool-utils';

const { Paragraph } = Typography;

interface ProxyExportModalProps {
  open: boolean;
  onClose: () => void;
}

export default function ProxyExportModal({ open, onClose }: ProxyExportModalProps) {
  const [format, setFormat] = useState<'mihomo' | 'base64'>('mihomo');
  const [result, setResult] = useState<AggregateExportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async (nextFormat: 'mihomo' | 'base64') => {
    const requestId = ++requestRef.current;
    setFormat(nextFormat);
    setResult(null);
    setLoading(true);
    try {
      const response = await proxyPoolAPI.exportAggregate({ format: nextFormat });
      if (requestId === requestRef.current && response.ok) setResult(response);
    } catch (error) {
      if (requestId === requestRef.current) message.error(getErrorMessage(error, '配置导出失败'));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load('mihomo');
  }, [load, open]);

  const close = () => {
    requestRef.current += 1;
    setLoading(false);
    onClose();
  };

  const download = () => {
    if (!result?.content) return;
    const blob = new Blob([result.content], { type: result.contentType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ai-home-proxy-pool.${format === 'mihomo' ? 'yaml' : 'txt'}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal title="聚合配置导出" open={open} onCancel={close} footer={null} width={760}>
      <Paragraph type="secondary">
        生成可下载或复制的配置内容，不会冒充长期在线订阅链接。只输出编译器实际支持的节点，并明确列出跳过项。
      </Paragraph>
      <div className="proxy-export-toolbar">
        <Radio.Group value={format} onChange={(event) => void load(event.target.value)}>
          <Radio.Button value="mihomo">Mihomo YAML</Radio.Button>
          <Radio.Button value="base64">Base64 节点列表</Radio.Button>
        </Radio.Group>
        <Space wrap>
          <Button
            icon={<CopyOutlined />}
            disabled={loading || !result?.content}
            onClick={() => result && void copyText(result.content, '配置内容已复制')}
          >
            复制
          </Button>
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            disabled={loading || !result?.content}
            onClick={download}
          >
            下载文件
          </Button>
        </Space>
      </div>
      {result && (
        <Space wrap className="proxy-export-summary">
          <Tag color="blue">请求 {result.requestedNodeCount ?? result.nodeCount}</Tag>
          <Tag color="green">导出 {result.exportedNodeCount ?? result.nodeCount}</Tag>
          <Tag color={result.skippedNodes?.length ? 'warning' : 'default'}>
            跳过 {result.skippedNodes?.length || 0}
          </Tag>
        </Space>
      )}
      {result?.warnings?.map((warning) => (
        <Alert key={warning} type="warning" showIcon message={warning} />
      ))}
      {result?.skippedNodes && result.skippedNodes.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="以下节点未导出"
          description={result.skippedNodes.map((item) => `${item.name || item.nodeId || '未知节点'}：${item.reason}`).join('；')}
        />
      )}
      <div className="toolkit-cmd-box proxy-export-content" aria-live="polite">
        {loading ? <Spin /> : <pre><code>{result?.content || '没有可导出的内容'}</code></pre>}
      </div>
    </Modal>
  );
}
