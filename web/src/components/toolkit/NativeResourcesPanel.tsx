import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Col, Empty, Row, Space, Spin, Tag, Typography, message } from 'antd';
import {
  ApiOutlined,
  CheckCircleOutlined,
  CodeOutlined,
  DeleteOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import type {
  NativeResourceAction,
  NativeResourceCapability,
  NativeResourceHostRow,
  NativeResourceKind,
  NativeResourceProviderRow,
  NativeResourceReport
} from '@/types';

const KIND_LABELS: Record<NativeResourceKind, string> = { plugin: '插件', skill: 'Skill', mcp: 'MCP' };
const KIND_ICONS: Record<NativeResourceKind, React.ReactNode> = {
  plugin: <CodeOutlined />,
  skill: <ExperimentOutlined />,
  mcp: <ApiOutlined />
};

function stateColor(state: string): string {
  if (state === 'supported') return 'success';
  if (state === 'projection-only') return 'warning';
  if (state === 'partial') return 'processing';
  return 'default';
}

function managedId(capability: NativeResourceCapability, kind: NativeResourceKind): string {
  const first = capability.managed?.[0];
  return first?.id || (kind === 'mcp' ? 'aih-demo' : 'aih-demo');
}

function ResourceCard({ provider, kind, capability, onAction, busy }: {
  provider: string;
  kind: NativeResourceKind;
  capability: NativeResourceCapability;
  onAction: (action: NativeResourceAction, capability: NativeResourceCapability) => void;
  busy: string;
}) {
  const record = capability.managed?.[0];
  const id = managedId(capability, kind);
  const enabled = record?.enabled !== false && Boolean(record);
  const supported = capability.state !== 'unsupported';
  const action = (name: NativeResourceAction) => `${provider}:${kind}:${name}`;
  return (
    <Card size="small" title={<Space>{KIND_ICONS[kind]}<span>{KIND_LABELS[kind]}</span></Space>}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space wrap>
          <Tag color={stateColor(capability.state)}>{capability.state}</Tag>
          {record ? <Tag icon={<CheckCircleOutlined />} color={enabled ? 'success' : 'default'}>{enabled ? '已启用' : '已停用'}</Tag> : <Tag>未托管</Tag>}
        </Space>
        <Typography.Text type="secondary">
          {capability.reason || capability.mode || capability.adapter || '由 provider 描述符提供能力'}
        </Typography.Text>
        <Typography.Text ellipsis={{ tooltip: capability.demo.command }} style={{ display: 'block' }}>
          Demo：{capability.demo.command}
        </Typography.Text>
        <Space wrap>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            disabled={!supported || Boolean(busy)}
            loading={busy === action('install')}
            onClick={() => onAction('install', capability)}
          >安装 demo</Button>
          {record ? (
            <>
              <Button
                size="small"
                icon={enabled ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                disabled={Boolean(busy)}
                loading={busy === action(enabled ? 'disable' : 'enable')}
                onClick={() => onAction(enabled ? 'disable' : 'enable', capability)}
              >{enabled ? '停用' : '启用'}</Button>
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                disabled={Boolean(busy)}
                loading={busy === action('remove')}
                onClick={() => onAction('remove', capability)}
              >移除</Button>
            </>
          ) : null}
          {kind === 'mcp' && record ? (
            <Button
              size="small"
              icon={<ApiOutlined />}
              disabled={Boolean(busy)}
              loading={busy === action('test')}
              onClick={() => onAction('test', capability)}
            >测试连接</Button>
          ) : null}
          {capability.demo.command && (capability.state === 'supported' || record) ? (
            <Button
              size="small"
              icon={<PlayCircleOutlined />}
              disabled={Boolean(busy)}
              loading={busy === action('demo')}
              onClick={() => onAction('demo', capability)}
            >运行 demo</Button>
          ) : null}
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {record ? `托管目标：${record.target || record.projection || id}` : `未安装；源包：${capability.demo.source}`}
        </Typography.Text>
      </Space>
    </Card>
  );
}

function ProviderRow({ row, onAction, busy }: {
  row: NativeResourceProviderRow;
  onAction: (provider: string, kind: NativeResourceKind, action: NativeResourceAction, capability: NativeResourceCapability) => void;
  busy: string;
}) {
  return (
    <Card
      size="small"
      title={<Space><strong>{row.provider}</strong><Tag color={row.runtime.available ? 'success' : 'default'}>{row.runtime.available ? `runtime ${row.runtime.version || 'available'}` : 'runtime unavailable'}</Tag></Space>}
      extra={<Typography.Text type="secondary">声明来自 {row.runtime.binary || 'provider descriptor'}</Typography.Text>}
    >
      <Row gutter={[12, 12]}>
        {(['plugin', 'skill', 'mcp'] as NativeResourceKind[]).map((kind) => (
          <Col xs={24} md={8} key={kind}>
            <ResourceCard
              provider={row.provider}
              kind={kind}
              capability={row.resources[kind]}
              busy={busy}
              onAction={(action, capability) => onAction(row.provider, kind, action, capability)}
            />
          </Col>
        ))}
      </Row>
    </Card>
  );
}

function HostRow({ row, onAction, busy }: {
  row: NativeResourceHostRow;
  onAction: (host: string, kind: NativeResourceKind, action: NativeResourceAction, capability: NativeResourceCapability) => void;
  busy: string;
}) {
  return (
    <Card
      size="small"
      title={<Space><strong>host/{row.host}</strong><Tag color={row.state === 'supported' ? 'success' : 'warning'}>{row.state}</Tag></Space>}
      extra={<Typography.Text type="secondary">{row.reason || 'imported host adapter'}</Typography.Text>}
    >
      <ResourceCard
        provider={`host/${row.host}`}
        kind="plugin"
        capability={row.resources.plugin}
        busy={busy}
        onAction={(action, capability) => onAction(row.host, 'plugin', action, capability)}
      />
    </Card>
  );
}

export default function NativeResourcesPanel() {
  const [report, setReport] = useState<NativeResourceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try { setReport(await toolkitAPI.getNativeResources()); }
    catch (error) { message.error(error instanceof Error ? error.message : '原生资源读取失败'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const providers = useMemo(() => report?.providers || [], [report]);
  const onAction = useCallback(async (provider: string, kind: NativeResourceKind, action: NativeResourceAction, capability: NativeResourceCapability) => {
    const record = capability.managed?.[0];
    const key = `${provider}:${kind}:${action}`;
    setBusy(key);
    try {
      const result = await toolkitAPI.operateNativeResource({
        ...(provider.startsWith('host/') ? { host: provider.slice('host/'.length) } : { provider }),
        kind,
        action,
        id: record?.id || (kind === 'mcp' ? 'aih-demo' : 'aih-demo')
      });
      if (result.result) message.success(`${provider} ${KIND_LABELS[kind]} ${action} 完成`);
      await load();
    } catch (error) { message.error(error instanceof Error ? error.message : `${KIND_LABELS[kind]} 操作失败`); }
    finally { setBusy(''); }
  }, [load]);
  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-native-resources">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">NATIVE RESOURCE CONTROL</div>
          <h2 id="toolkit-native-resources">插件、Skill 与 MCP</h2>
          <Typography.Text type="secondary">统一管理投影，按 provider 查看真实 runtime 和可运行 demo。projection-only 不会被伪装成原生执行。</Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>重新探测</Button>
      </header>
      {loading && !report ? <div className="toolkit-loading"><Spin size="large" /></div> : null}
      {!loading && !providers.length ? <Empty description="没有可用 provider 描述" /> : null}
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {providers.map((row) => <ProviderRow key={row.provider} row={row} onAction={onAction} busy={busy} />)}
        {report?.hosts?.map((row) => <HostRow key={row.host} row={row} onAction={onAction} busy={busy} />)}
      </Space>
      {report ? <Typography.Text type="secondary" style={{ display: 'block', marginTop: 16 }}>{report.evidenceBoundary}</Typography.Text> : null}
    </section>
  );
}
