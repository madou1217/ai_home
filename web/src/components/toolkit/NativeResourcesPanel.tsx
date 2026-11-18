import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Empty, Space, Spin, Tag, Typography, message } from 'antd';
import {
  ApiOutlined,
  BookOutlined,
  CheckCircleOutlined,
  CodeOutlined,
  DeleteOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import type {
  NativeResourceAction,
  NativeResourceKind,
  NativeResourceManagedRecord,
  NativeResourceReport
} from '@/types';

const KIND_LABELS: Record<NativeResourceKind, string> = { plugin: '插件', skill: 'Skill', mcp: 'MCP' };
const KIND_ICONS: Record<NativeResourceKind, React.ReactNode> = {
  plugin: <CodeOutlined />,
  skill: <BookOutlined />,
  mcp: <ApiOutlined />
};

type ManagedAction = Extract<NativeResourceAction, 'enable' | 'disable' | 'remove' | 'test'>;

function recordKey(record: NativeResourceManagedRecord): string {
  return `${record.host ? `host/${record.host}` : record.provider}:${record.kind}:${record.id}`;
}

function ResourceCard({ record, onAction, busy }: {
  record: NativeResourceManagedRecord;
  onAction: (record: NativeResourceManagedRecord, action: ManagedAction) => void;
  busy: string;
}) {
  const enabled = record.enabled !== false;
  const key = recordKey(record);
  const owner = record.host ? `host/${record.host}` : record.provider;
  return (
    <Card size="small" title={<Space>{KIND_ICONS[record.kind]}<strong>{record.id}</strong><Tag>{KIND_LABELS[record.kind]}</Tag></Space>}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space wrap>
          <Typography.Text>{owner}</Typography.Text>
          <Tag icon={<CheckCircleOutlined />} color={enabled ? 'success' : 'default'}>{enabled ? '已启用' : '已停用'}</Tag>
          {record.mode ? <Tag>{record.mode}</Tag> : null}
        </Space>
        <Space wrap>
          <Button
            size="small"
            icon={enabled ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
            disabled={Boolean(busy)}
            loading={busy === `${key}:${enabled ? 'disable' : 'enable'}`}
            onClick={() => onAction(record, enabled ? 'disable' : 'enable')}
          >{enabled ? '停用' : '启用'}</Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            disabled={Boolean(busy)}
            loading={busy === `${key}:remove`}
            onClick={() => onAction(record, 'remove')}
          >移除</Button>
          {record.kind === 'mcp' ? (
            <Button
              size="small"
              icon={<ApiOutlined />}
              disabled={Boolean(busy)}
              loading={busy === `${key}:test`}
              onClick={() => onAction(record, 'test')}
            >测试连接</Button>
          ) : null}
        </Space>
        {record.target || record.projection ? <Typography.Text type="secondary">托管目标：{record.target || record.projection}</Typography.Text> : null}
      </Space>
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
  const records = useMemo(() => (['plugin', 'skill', 'mcp'] as const)
    .flatMap((kind) => (report?.managed?.[kind] || []).map((record) => ({ ...record, kind })))
    .filter((record) => !record.removed), [report]);
  const onAction = useCallback(async (record: NativeResourceManagedRecord, action: ManagedAction) => {
    setBusy(`${recordKey(record)}:${action}`);
    try {
      await toolkitAPI.operateNativeResource({
        ...(record.host ? { host: record.host } : { provider: record.provider }),
        kind: record.kind,
        action,
        id: record.id
      });
      message.success(`${record.id} ${KIND_LABELS[record.kind]} ${action === 'enable' ? '已启用' : action === 'disable' ? '已停用' : action === 'remove' ? '已移除' : '连接检查完成'}`);
      await load();
    } catch (error) { message.error(error instanceof Error ? error.message : `${KIND_LABELS[record.kind]} 操作失败`); }
    finally { setBusy(''); }
  }, [load]);
  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-native-resources">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">NATIVE RESOURCE CONTROL</div>
          <h2 id="toolkit-native-resources">插件、Skill 与 MCP</h2>
          <Typography.Text type="secondary">仅管理实际已安装的资源；宿主能力声明不代表插件已安装或已验证运行。</Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>重新探测</Button>
      </header>
      {loading && !report ? <div className="toolkit-loading"><Spin size="large" /></div> : null}
      {!loading && !records.length ? <Empty description="暂无已安装资源，请使用正式发布的插件、Skill 或 MCP" /> : null}
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {records.map((record) => <ResourceCard key={recordKey(record)} record={record} onAction={onAction} busy={busy} />)}
      </Space>
      {report ? <Typography.Text type="secondary" style={{ display: 'block', marginTop: 16 }}>{report.evidenceBoundary}</Typography.Text> : null}
    </section>
  );
}
