import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { copyText } from '@/components/toolkit/proxy-pool/proxy-pool-utils';
import { aggregatorErrorText } from './aggregator-presentation';
import { subscriptionAggregatorAPI } from './subscription-aggregator-api';
import type { AggregatorFormat, AggregatorPreview, AggregatorProfile } from './types';
import styles from './SubscriptionAggregator.module.css';

const { Text } = Typography;

const FORMAT_OPTIONS: Array<{ label: string; value: AggregatorFormat }> = [
  { label: 'Clash / mihomo', value: 'mihomo' },
  { label: 'sing-box', value: 'sing-box' },
  { label: 'Base64', value: 'base64' }
];

const EXTENSIONS: Record<AggregatorFormat, string> = { mihomo: 'yaml', 'sing-box': 'json', base64: 'txt' };

function warningText(warning: string) {
  if (warning === 'aggregator_no_nodes') return '没有节点被选中，检查订阅源范围与过滤条件';
  const match = warning.match(/^aggregator_policy_fallback:(.+):([^:]+:[^:]+|[^:]+)$/);
  if (match) return `「${match[1]}」引用的 ${match[2]} 没有对应策略组，已改用节点选择`;
  return warning;
}

interface ProfilePreviewModalProps {
  profile: AggregatorProfile | null;
  onClose: () => void;
  width?: number | string;
}

/** 预览聚合结果：只渲染库里现有节点，不触发订阅源刷新。 */
export default function ProfilePreviewModal({ profile, onClose, width = 860 }: ProfilePreviewModalProps) {
  const [format, setFormat] = useState<AggregatorFormat>('mihomo');
  const [preview, setPreview] = useState<AggregatorPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  const load = useCallback(async (profileId: string, nextFormat: AggregatorFormat) => {
    const requestId = ++requestRef.current;
    setFormat(nextFormat);
    setLoading(true);
    setError('');
    try {
      const result = await subscriptionAggregatorAPI.preview(profileId, nextFormat);
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
    if (profile) void load(profile.id, 'mihomo');
  }, [load, profile]);

  const download = () => {
    if (!preview?.content || !profile) return;
    const blob = new Blob([preview.content], { type: preview.contentType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${profile.name}.${EXTENSIONS[format]}`;
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
        <Segmented
          value={format}
          options={FORMAT_OPTIONS}
          onChange={(value) => profile && void load(profile.id, value as AggregatorFormat)}
        />
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
          {preview.stats.skipped > 0 && <Tag color="warning">格式不支持 {preview.stats.skipped}</Tag>}
        </Space>
      )}
      {error && <Text type="danger">{error}</Text>}
      {preview?.warnings.map((warning) => (
        <Text key={warning} type="warning" className={styles.previewWarning}>{warningText(warning)}</Text>
      ))}
      {preview && preview.skippedNodes.length > 0 && (
        <Text type="secondary" className={styles.previewWarning}>
          未输出：{preview.skippedNodes.slice(0, 8).map((item) => `${item.name}（${item.reason}）`).join('；')}
          {preview.skippedNodes.length > 8 ? ` 等 ${preview.skippedNodes.length} 个` : ''}
        </Text>
      )}
      <div className="toolkit-cmd-box" aria-live="polite">
        {loading ? <Spin /> : <pre className={styles.previewContent}><code>{preview?.content || ''}</code></pre>}
      </div>
    </Modal>
  );
}
