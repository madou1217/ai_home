import { useCallback, useEffect, useMemo, useState } from 'react';
import { Empty, Progress, Space, Spin, Table, Tag, Tooltip, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudDownloadOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  WarningOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import SectionCard from '@/components/ui/SectionCard';
import { geoResourceAPI, type GeoProviderAvailability, type GeoResource, type GeoResourceJob } from './geo-resource-api';

const { Text } = Typography;

function formatBytes(bytes: number) {
  if (!bytes) return '—';
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function formatTime(at: number) {
  if (!at) return '从未';
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 能力标签：国家 / 省州 / 城市 / ASN。 */
function CapabilityTags({ capabilities }: { capabilities: GeoProviderAvailability['capabilities'] }) {
  const items: Array<[string, boolean]> = [
    ['国家', capabilities.country],
    ['省州', capabilities.region],
    ['城市', capabilities.city],
    ['ASN', capabilities.asn]
  ];
  return (
    <Space size={4} wrap>
      {items.map(([label, on]) => (
        <Tag key={label} color={on ? 'blue' : undefined} style={on ? undefined : { opacity: 0.45 }}>
          {label}
        </Tag>
      ))}
    </Space>
  );
}

/**
 * GeoIP 数据（工具箱 → 网络）：本地归属地库的下载与更新。
 *
 * 为什么是本地库：出口位置查询分两段 —— ① 经节点拿出口 IP（必须出网）；
 * ② IP → 归属地（**纯本地** mmdb 查表，微秒级）。之前 ② 走在线 API，慢且不稳定。
 * 这里管理的是 ② 用的数据文件：本机客户端自带的库会被自动复用（只读），
 * 缺城市级精度时下载 DB-IP City Lite 补齐。
 */
export default function GeoResourcePanel() {
  const [resources, setResources] = useState<GeoResource[]>([]);
  const [providers, setProviders] = useState<GeoProviderAvailability[]>([]);
  const [jobs, setJobs] = useState<GeoResourceJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const view = await geoResourceAPI.view();
      setResources(view.resources || []);
      setProviders(view.providers || []);
      setJobs(view.jobs || []);
      setError('');
    } catch (loadError: unknown) {
      setError((loadError as Error)?.message || '读取 GeoIP 数据状态失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // 有进行中的作业时轮询（下载 60MB 要几十秒，用户要看到进度）。
  useEffect(() => {
    if (!jobs.length) return undefined;
    const timer = window.setInterval(() => { void load(); }, 2000);
    return () => window.clearInterval(timer);
  }, [jobs.length, load]);

  const runAction = async (resourceId: string, action: 'install' | 'update' | 'uninstall', label: string) => {
    setBusy(`${action}:${resourceId}`);
    try {
      const result = await geoResourceAPI.start(resourceId, action);
      if (!result.ok) message.warning(result.error || '操作未开始');
      else message.success(`${label}已开始`);
      await load();
    } catch (actionError: unknown) {
      message.error((actionError as Error)?.message || '操作失败');
    } finally {
      setBusy('');
    }
  };

  const availableCount = useMemo(() => providers.filter((provider) => provider.available).length, [providers]);
  const hasCity = useMemo(() => providers.some((provider) => provider.available && provider.capabilities.city), [providers]);

  const columns: ColumnsType<GeoResource> = [
    {
      title: '数据源',
      key: 'name',
      render: (_value, resource) => (
        <div>
          <div><strong>{resource.name}</strong></div>
          <Text type="secondary" style={{ fontSize: 12 }}>{resource.role}</Text>
        </div>
      )
    },
    {
      title: '提供字段',
      key: 'capabilities',
      width: 220,
      render: (_value, resource) => <CapabilityTags capabilities={resource.capabilities} />
    },
    {
      title: '状态',
      key: 'status',
      width: 200,
      render: (_value, resource) => (
        resource.installed
          ? (
            <Space direction="vertical" size={0}>
              <Tag color="success" icon={<CheckCircleOutlined />}>已安装 · {formatBytes(resource.bytes)}</Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>更新于 {formatTime(resource.updatedAt)}</Text>
            </Space>
          )
          : (
            <Space direction="vertical" size={0}>
              <Tag icon={<WarningOutlined />}>未安装</Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>{resource.sizeHint}</Text>
            </Space>
          )
      )
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_value, resource) => (
        <Space size={4}>
          <Button
            size="small"
            type={resource.installed ? 'default' : 'primary'}
            icon={<CloudDownloadOutlined />}
            loading={busy === `${resource.installed ? 'update' : 'install'}:${resource.id}`}
            onClick={() => void runAction(resource.id, resource.installed ? 'update' : 'install', resource.installed ? '更新' : '下载')}
          >
            {resource.installed ? '更新' : '下载'}
          </Button>
          {resource.installed && (
            <Tooltip title="删除托管的数据文件（本机客户端自带的库不受影响）">
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                loading={busy === `uninstall:${resource.id}`}
                aria-label={`删除 ${resource.name}`}
                onClick={() => void runAction(resource.id, 'uninstall', '删除')}
              />
            </Tooltip>
          )}
        </Space>
      )
    }
  ];

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="geo-resource-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">GEOIP DATA</div>
          <h2 id="geo-resource-title">GeoIP 数据</h2>
          <p>
            出口位置查询用的本地归属地库。查询分两段：经节点拿到出口 IP（必须出网），
            再由本地库查出归属地（微秒级、零网络、不走在线 API）。本机客户端自带的库会被自动复用，只读不改。
          </p>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
      </header>

      {error && <InlineNote tone="error" description={error}>读取 GeoIP 数据状态失败</InlineNote>}

      {loading && !resources.length ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在读取 GeoIP 数据" /></div>
      ) : (
        <>
          {!hasCity && (
            <InlineNote tone="info" description="当前没有城市级数据源：位置结果只到「国家 / ASN」。下载 DB-IP City Lite 可补齐省州与城市。">
              城市级精度未启用
            </InlineNote>
          )}

          <SectionCard title="可下载的数据源" className="toolkit-section-spaced">
            <Table
              size="small"
              rowKey="id"
              columns={columns}
              dataSource={resources}
              pagination={false}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可管理的数据源" /> }}
            />
          </SectionCard>

          <SectionCard title={`数据来源（${availableCount}/${providers.length} 可用）`} className="toolkit-section-spaced">
            <Text type="secondary">
              按顺序尝试，前一个不可用或查不到就自动切下一个；国家与 ASN 会从不同库合并。
            </Text>
            <Table
              size="small"
              rowKey="id"
              style={{ marginTop: 12 }}
              pagination={false}
              dataSource={providers}
              columns={[
                {
                  title: '来源',
                  key: 'name',
                  render: (_value, provider: GeoProviderAvailability) => (
                    <Space size={6}>
                      <span>{provider.name}</span>
                      <Text type="secondary" style={{ fontSize: 12 }}>{provider.id}</Text>
                    </Space>
                  )
                },
                {
                  title: '提供字段',
                  key: 'capabilities',
                  width: 220,
                  render: (_value, provider: GeoProviderAvailability) => <CapabilityTags capabilities={provider.capabilities} />
                },
                {
                  title: '状态',
                  key: 'status',
                  width: 180,
                  render: (_value, provider: GeoProviderAvailability) => (
                    provider.available
                      ? <Tag color="success">可用</Tag>
                      : <Tooltip title={provider.error}><Tag>缺数据文件</Tag></Tooltip>
                  )
                }
              ]}
            />
          </SectionCard>

          {jobs.length > 0 && (
            <SectionCard title="进行中的任务" className="toolkit-section-spaced">
              {jobs.map((job) => (
                <div key={job.id} style={{ marginBottom: 12 }}>
                  <Space size={8}>
                    <strong>{job.taskName}</strong>
                    <Tag>{job.action === 'uninstall' ? '删除' : job.action === 'update' ? '更新' : '下载'}</Tag>
                  </Space>
                  <Progress
                    percent={Math.round(job.progress?.percent || 0)}
                    size="small"
                    status={job.status === 'failed' ? 'exception' : 'active'}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>{job.progress?.label || '等待中'}</Text>
                </div>
              ))}
            </SectionCard>
          )}
        </>
      )}
    </section>
  );
}
