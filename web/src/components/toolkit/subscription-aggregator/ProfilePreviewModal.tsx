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
  // 本机中转：默认关（不替用户起进程），点「启动本机中转」才请求服务端拉起边车。
  const [relayOn, setRelayOn] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async (profileId: string, nextFormat: AggregatorFormat, nextClient: string, nextRelay = false) => {
    const requestId = ++requestRef.current;
    setFormat(nextFormat);
    setClient(nextClient);
    setRelayOn(nextRelay);
    setLoading(true);
    setError('');
    try {
      const result = await subscriptionAggregatorAPI.preview(profileId, nextFormat, nextClient, { relay: nextRelay });
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
    void load(profile.id, clientFormat || format, nextClient, relayOn);
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

  const currentFormat = formats.find((item) => item.id === (preview?.format ?? format));
  const formatName = currentFormat?.name || '';

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
            onChange={(value) => profile && void load(profile.id, value, client, relayOn)}
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
      {/* 格式自身的限制（例如 Clash 全协议需要 Meta 系内核）：选格式时就摆出来，别等客户端加载失败。 */}
      {currentFormat?.note ? <Text type="secondary" className={styles.previewWarning}>{currentFormat.note}</Text> : null}
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
      {/* 本机中转：只有「目标格式/内核表达不了」的协议存在时才出现（后端 relay.candidates > 0）。
          同机的 ClashX 之类老内核、Surge 的 VLESS 节点都靠它；远端客户端走「可达地址 + 认证」形态。 */}
      {preview?.relay && (preview.relay.candidates || 0) > 0 && (
        <Space wrap className={styles.previewStats}>
          <Text type="secondary">
            本机中转：
            {preview.relay.active
              ? `已运行，${preview.relay.nodes} 个节点走本地入口`
              : preview.relay.available === false ? '内核缺失，无法启动' : '未运行'}
          </Text>
          {!preview.relay.active && preview.relay.available !== false && (
            <Button
              appVariant="quiet"
              disabled={loading || !profile}
              onClick={() => profile && void load(profile.id, format, client, true)}
            >
              启动本机中转
            </Button>
          )}
          {preview.relay.version ? <Tag>sing-box {preview.relay.version}</Tag> : null}
          {/* 远端客户端连的是「它自己的 Host + 这段端口」：得放行，否则那些节点连不上。 */}
          {preview.relay.active && preview.relay.remote && preview.relay.portRange ? (
            <Tag color="warning">
              {preview.relay.advertiseHost}:{preview.relay.portRange} 需对客户端可达
            </Tag>
          ) : null}
          {preview.relay.active && preview.relay.authRequired ? <Tag>入口已启用认证</Tag> : null}
          {preview.relay.skipped && preview.relay.skipped.length > 0 && (
            <Text type="secondary">
              中转跳过 {preview.relay.skipped.length} 个节点（{skipReasonText(preview.relay.skipped[0].reason)}）
            </Text>
          )}
        </Space>
      )}
      {error && <Text type="danger">{error}</Text>}
      {preview?.warnings.map((warning) => (
        <Text key={warning} type="warning" className={styles.previewWarning}>{previewWarningText(warning, describePolicy, formatName)}</Text>
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
