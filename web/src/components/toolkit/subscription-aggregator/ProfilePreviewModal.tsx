import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Select, Space, Spin, Tag, Typography } from 'antd';
import { CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { copyText } from '@/components/toolkit/proxy-pool/proxy-pool-utils';
import { aggregatorErrorText, formatOptions, previewWarningText, skipReasonText } from './aggregator-presentation';
import { subscriptionAggregatorAPI } from './subscription-aggregator-api';
import type {
  AggregatorClientInfo,
  AggregatorFormat,
  AggregatorFormatInfo,
  AggregatorPreview,
  AggregatorProfile
} from './types';
import styles from './SubscriptionAggregator.module.css';

const { Text } = Typography;

const DEFAULT_FORMAT = 'mihomo';

interface ProfilePreviewModalProps {
  profile: AggregatorProfile | null;
  /** 服务端 catalog.formats */
  formats: AggregatorFormatInfo[];
  /** 服务端 catalog.clients：选一个客户端，预览就是它实际拿到的内容 */
  clients: AggregatorClientInfo[];
  /** 把 region:jp 之类的策略引用换成组名（提示里用） */
  describePolicy?: (policy: string) => string;
  onClose: () => void;
  width?: number | string;
}

/** 预览聚合结果：只渲染库里现有节点，不触发订阅源刷新。可以模拟某个客户端。 */
export default function ProfilePreviewModal({ profile, formats, clients, describePolicy, onClose, width = 860 }: ProfilePreviewModalProps) {
  const [format, setFormat] = useState<AggregatorFormat>(DEFAULT_FORMAT);
  const [client, setClient] = useState('');
  const [preview, setPreview] = useState<AggregatorPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  const load = useCallback(async (profileId: string, nextFormat: AggregatorFormat, nextClient: string) => {
    const requestId = ++requestRef.current;
    setFormat(nextFormat);
    setClient(nextClient);
    setLoading(true);
    setError('');
    try {
      const result = await subscriptionAggregatorAPI.preview(profileId, nextFormat, nextClient);
      if (requestId === requestRef.current) setPreview(result);
    } catch (loadError) {
      const code = (loadError as { response?: { data?: { error?: string } } })?.response?.data?.error;
      if (requestId === requestRef.current) setError(aggregatorErrorText(code, '生成预览失败'));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPreview(null);
    if (profile) void load(profile.id, DEFAULT_FORMAT, '');
  }, [load, profile]);

  // 选客户端时格式跟着换成它默认拿到的格式（之后仍可手动改格式）。
  const changeClient = (nextClient: string) => {
    if (!profile) return;
    const clientFormat = clients.find((item) => item.id === nextClient)?.format;
    void load(profile.id, clientFormat || format, nextClient);
  };

  const download = () => {
    if (!preview?.content || !profile) return;
    const blob = new Blob([preview.content], { type: preview.contentType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const extension = formats.find((item) => item.id === format)?.extension || 'txt';
    anchor.download = `${profile.name}.${extension}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal
      title={profile ? `预览 · ${profile.name}` : '预览'}
      open={Boolean(profile)}
      onCancel={() => {
        requestRef.current += 1;
        onClose();
      }}
      footer={null}
      width={width}
      destroyOnHidden
    >
      <div className={styles.previewToolbar}>
        <Space wrap>
          <Select
            aria-label="预览格式"
            value={format}
            options={formatOptions(formats)}
            onChange={(value) => profile && void load(profile.id, value, client)}
            popupMatchSelectWidth={false}
            style={{ minWidth: 200 }}
          />
          <Select
            aria-label="模拟客户端"
            value={client}
            options={[{ label: '不模拟客户端', value: '' }, ...clients.map((item) => ({ label: item.name, value: item.id }))]}
            onChange={changeClient}
            popupMatchSelectWidth={false}
            showSearch
            optionFilterProp="label"
            style={{ minWidth: 180 }}
          />
        </Space>
        <Space wrap>
          <Button icon={<CopyOutlined />} disabled={loading || !preview?.content} onClick={() => preview && void copyText(preview.content, '配置已复制')}>
            复制
          </Button>
          <Button type="primary" icon={<DownloadOutlined />} disabled={loading || !preview?.content} onClick={download}>
            下载
          </Button>
        </Space>
      </div>
      {preview && (
        <Space wrap className={styles.previewStats}>
          <Tag color="blue">节点 {preview.stats.nodes}</Tag>
          <Tag>策略组 {preview.stats.groups}</Tag>
          <Tag>地区 {preview.stats.regions}</Tag>
          <Tag>规则 {preview.stats.rules}</Tag>
          <Tag>过滤 {preview.stats.filtered}</Tag>
          <Tag>去重 {preview.stats.duplicates}</Tag>
          {preview.stats.skipped > 0 && <Tag color="warning">未输出 {preview.stats.skipped}</Tag>}
          {preview.client && <Tag color="purple">按 {preview.client.name} 输出</Tag>}
          {preview.view === 'nodes' && <Tag>仅节点</Tag>}
        </Space>
      )}
      {error && <Text type="danger">{error}</Text>}
      {preview?.warnings.map((warning) => (
        <Text key={warning} type="warning" className={styles.previewWarning}>{previewWarningText(warning, describePolicy)}</Text>
      ))}
      {preview && preview.skippedNodes.length > 0 && (
        <Text type="secondary" className={styles.previewWarning}>
          未输出：{preview.skippedNodes.slice(0, 8).map((item) => `${item.name}（${skipReasonText(item.reason)}）`).join('；')}
          {preview.skippedNodes.length > 8 ? ` 等 ${preview.skippedNodes.length} 个` : ''}
        </Text>
      )}
      <div className="toolkit-cmd-box" aria-live="polite">
        {loading ? <Spin /> : <pre className={styles.previewContent}><code>{preview?.content || ''}</code></pre>}
      </div>
    </Modal>
  );
}
