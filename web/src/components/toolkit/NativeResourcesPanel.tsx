import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Empty, Popconfirm, Space, Spin, Tabs, Tag, Typography, message } from 'antd';
import {
  ApiOutlined,
  BookOutlined,
  CodeOutlined,
  DeleteOutlined,
  InfoCircleOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
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
import NativeResourceDetailModal from './NativeResourceDetailModal';
import NativeResourceInstallModal from './NativeResourceInstallModal';
import {
  KIND_LABELS,
  RESOURCE_KINDS,
  groupNativeResources,
  isEnabled,
  resourceKey,
  resourceOwner,
  resourceSummary
} from './native-resource-grouping';
import type { NativeResourceGroup } from './native-resource-grouping';

type ManagedAction = Extract<NativeResourceAction, 'enable' | 'disable' | 'remove' | 'test'>;

const KIND_ICONS: Record<NativeResourceKind, React.ReactNode> = {
  plugin: <CodeOutlined />,
  skill: <BookOutlined />,
  mcp: <ApiOutlined />
};

function actionTargets(group: NativeResourceGroup, action: ManagedAction): NativeResourceManagedRecord[] {
  if (action === 'enable') return group.records.filter((record) => !isEnabled(record));
  if (action === 'disable') return group.records.filter(isEnabled);
  return group.records;
}

function actionLabel(action: ManagedAction, count: number): string {
  const prefix = count > 1 ? '全部' : '';
  if (action === 'enable') return `${prefix}启用`;
  if (action === 'disable') return `${prefix}停用`;
  return `${prefix}移除`;
}

export default function NativeResourcesPanel() {
  const [report, setReport] = useState<NativeResourceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeKind, setActiveKind] = useState<NativeResourceKind>('plugin');
  const [busy, setBusy] = useState('');
  const [bulkBusy, setBulkBusy] = useState('');
  const [installOpen, setInstallOpen] = useState(false);
  const [detailGroup, setDetailGroup] = useState<NativeResourceGroup | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setReport(await toolkitAPI.getNativeResources()); }
    catch (error) { message.error(error instanceof Error ? error.message : '原生资源读取失败'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 详情弹窗持有分组快照；操作后报告刷新时同步到新状态，避免弹窗内状态不更新。
  useEffect(() => {
    if (!detailGroup) return;
    const next = groups.find((group) => group.key === detailGroup.key);
    if (!next) {
      setDetailGroup(null);
      return;
    }
    if (next !== detailGroup) setDetailGroup(next);
  }, [groups, detailGroup]);

  const groups = useMemo(() => groupNativeResources(report), [report]);
  const counts = useMemo(() => {
    const next: Record<NativeResourceKind, number> = { plugin: 0, skill: 0, mcp: 0 };
    for (const group of groups) next[group.kind] += 1;
    return next;
  }, [groups]);
  const visibleGroups = useMemo(
    () => groups.filter((group) => group.kind === activeKind),
    [groups, activeKind]
  );

  const operate = useCallback(async (
    record: NativeResourceManagedRecord,
    action: ManagedAction
  ): Promise<boolean> => {
    setBusy(`${resourceKey(record)}:${action}`);
    try {
      await toolkitAPI.operateNativeResource({
        ...(record.host ? { host: record.host } : { provider: record.provider }),
        kind: record.kind,
        action,
        id: record.id
      });
      await load();
      return true;
    } catch (error) {
      message.error(error instanceof Error ? error.message : `${KIND_LABELS[record.kind]} 操作失败`);
      return false;
    } finally {
      setBusy('');
    }
  }, [load]);

  const runSingle = useCallback(async (record: NativeResourceManagedRecord, action: ManagedAction) => {
    const ok = await operate(record, action);
    if (ok) {
      message.success(`${record.id} · ${resourceOwner(record)} ${action === 'enable' ? '已启用' : action === 'disable' ? '已停用' : action === 'remove' ? '已移除' : '连接检查完成'}`);
      if (action === 'remove') setDetailGroup(null);
    }
  }, [operate]);

  const runBulk = useCallback(async (group: NativeResourceGroup, action: ManagedAction) => {
    const targets = actionTargets(group, action);
    if (!targets.length) return;
    setBulkBusy(group.key);
    try {
      const results = await Promise.allSettled(targets.map((record) => toolkitAPI.operateNativeResource({
        ...(record.host ? { host: record.host } : { provider: record.provider }),
        kind: record.kind,
        action,
        id: record.id
      })));
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length) {
        const reason = failed[0] as PromiseRejectedResult;
        message.warning(`${actionLabel(action, targets.length)}完成 ${targets.length - failed.length}/${targets.length}；${reason.reason instanceof Error ? reason.reason.message : '部分宿主失败'}`);
      } else {
        message.success(`${group.id} ${actionLabel(action, targets.length)}完成`);
      }
      await load();
    } finally {
      setBulkBusy('');
    }
  }, [load]);

  const renderGroup = (group: NativeResourceGroup) => {
    const enabledCount = group.records.filter(isEnabled).length;
    const allEnabled = enabledCount === group.records.length;
    const multi = group.records.length > 1;
    const summary = group.description
      || (group.kind === 'mcp'
        ? Array.from(new Set(group.records.map(resourceSummary))).join(' · ')
        : '未提供描述');
    return (
      <Card
        key={group.key}
        size="small"
        className="toolkit-native-resource-card"
        title={(
          <Space wrap size={8}>
            {KIND_ICONS[group.kind]}
            <strong>{group.id}</strong>
            <Tag>{KIND_LABELS[group.kind]}</Tag>
            {group.version ? <Tag>{group.version}</Tag> : null}
            <Tag color={enabledCount ? 'success' : 'default'}>{enabledCount}/{group.records.length} 启用</Tag>
          </Space>
        )}
        extra={(
          <Button size="small" icon={<InfoCircleOutlined />} onClick={() => setDetailGroup(group)}>
            详情
          </Button>
        )}
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Typography.Paragraph
            type="secondary"
            style={{ margin: 0 }}
            ellipsis={{ rows: 2, tooltip: summary }}
          >
            {summary}
          </Typography.Paragraph>
          <Space wrap size={[6, 6]}>
            {group.records.map((record) => (
              <Tag key={resourceKey(record)} color={isEnabled(record) ? 'success' : 'default'}>
                {resourceOwner(record)}
              </Tag>
            ))}
          </Space>
          <Space wrap size={6}>
            {!allEnabled ? (
              <Button
                size="small"
                icon={<PlayCircleOutlined />}
                disabled={Boolean(bulkBusy)}
                loading={bulkBusy === group.key}
                onClick={() => void runBulk(group, 'enable')}
              >{actionLabel('enable', actionTargets(group, 'enable').length)}</Button>
            ) : null}
            {enabledCount ? (
              <Button
                size="small"
                icon={<PauseCircleOutlined />}
                disabled={Boolean(bulkBusy)}
                loading={bulkBusy === group.key}
                onClick={() => void runBulk(group, 'disable')}
              >{actionLabel('disable', actionTargets(group, 'disable').length)}</Button>
            ) : null}
            <Popconfirm
              title={`移除 ${group.id} 的全部 ${group.records.length} 个投影？`}
              description={multi ? '将逐个宿主执行，已修改的投影会保留并报错。' : undefined}
              okText="移除"
              cancelText="取消"
              danger
              onConfirm={() => void runBulk(group, 'remove')}
            >
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                disabled={Boolean(busy) || Boolean(bulkBusy)}
              >{actionLabel('remove', group.records.length)}</Button>
            </Popconfirm>
          </Space>
        </Space>
      </Card>
    );
  };

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-native-resources">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">NATIVE RESOURCE CONTROL</div>
          <h2 id="toolkit-native-resources">插件、Skill 与 MCP</h2>
          <Typography.Text type="secondary">
            按资源合并展示：同一 Skill 在不同 Provider / Harness 的投影收敛为一张卡片；启停与移除按宿主分别执行。
          </Typography.Text>
        </div>
        <Space>
          <Button icon={<PlusOutlined />} type="primary" onClick={() => setInstallOpen(true)}>安装</Button>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>重新探测</Button>
        </Space>
      </header>
      {loading && !report ? <div className="toolkit-loading"><Spin size="large" /></div> : null}
      {!loading && !groups.length ? <Empty description="暂无已安装资源，可使用右上角安装" /> : null}
      {groups.length ? (
        <Tabs
          className="toolkit-native-resource-tabs"
          activeKey={activeKind}
          onChange={(value) => setActiveKind(value as NativeResourceKind)}
          items={RESOURCE_KINDS.map((kind) => ({
            key: kind,
            label: <span>{KIND_ICONS[kind]} {KIND_LABELS[kind]}<Tag className="toolkit-native-resource-count">{counts[kind]}</Tag></span>,
            children: (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {visibleGroups.length
                  ? visibleGroups.map(renderGroup)
                  : <Empty description={`当前没有已安装的${KIND_LABELS[kind]}`} />}
              </Space>
            )
          }))}
        />
      ) : null}
      {report ? (
        <Typography.Text type="secondary" style={{ display: 'block' }}>
          此页仅反映安装与启停状态，不作为插件已真实执行的证明。
        </Typography.Text>
      ) : null}
      <NativeResourceDetailModal
        group={detailGroup}
        busy={busy}
        onClose={() => setDetailGroup(null)}
        onAction={runSingle}
      />
      <NativeResourceInstallModal
        open={installOpen}
        report={report}
        initialKind={activeKind}
        onClose={() => setInstallOpen(false)}
        onInstalled={(kind) => {
          setActiveKind(kind);
          void load();
        }}
      />
    </section>
  );
}
