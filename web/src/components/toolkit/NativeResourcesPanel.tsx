import { useCallback, useEffect, useMemo, useState } from 'react';
import { Space, Tabs, Tag, message } from 'antd';
import {
  ApiOutlined,
  BookOutlined,
  CodeOutlined,
  ExperimentOutlined,
  PlusOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import HudStateView from '@/components/hud/HudStateView';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import { toolkitAPI } from '@/services/api';
import type {
  NativeResourceKind,
  NativeResourceManagedRecord,
  NativeResourceReport
} from '@/types';
import AihPluginPanel from './AihPluginPanel';
import NativeResourceDetailModal from './NativeResourceDetailModal';
import NativeResourceGroupCard, {
  nativeActionLabel,
  nativeActionTargets,
  type ManagedNativeAction
} from './NativeResourceGroupCard';
import NativeResourceInstallModal from './NativeResourceInstallModal';
import NativeResourceSkillRepo from './NativeResourceSkillRepo';
import ToolkitEmptyState from './ToolkitEmptyState';
import ToolkitPanelHeader from './ToolkitPanelHeader';
import {
  KIND_LABELS,
  RESOURCE_KINDS,
  groupNativeResources,
  resourceKey,
  resourceOwner
} from './native-resource-grouping';
import type { NativeResourceGroup } from './native-resource-grouping';

type ResourceTab = NativeResourceKind | 'aih';

const KIND_ICONS: Record<NativeResourceKind, React.ReactNode> = {
  plugin: <CodeOutlined />,
  skill: <BookOutlined />,
  mcp: <ApiOutlined />
};

export default function NativeResourcesPanel() {
  const [report, setReport] = useState<NativeResourceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [activeKind, setActiveKind] = useState<ResourceTab>('plugin');
  const [busy, setBusy] = useState('');
  const [bulkBusy, setBulkBusy] = useState('');
  const [installOpen, setInstallOpen] = useState(false);
  const [detailGroup, setDetailGroup] = useState<NativeResourceGroup | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      setReport(await toolkitAPI.getNativeResources());
    } catch (error) {
      const detail = error instanceof Error ? error.message : '原生资源读取失败';
      setLoadError(detail);
      message.error(detail);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => groupNativeResources(report), [report]);
  const counts = useMemo(() => {
    const next: Record<NativeResourceKind, number> = { plugin: 0, skill: 0, mcp: 0 };
    for (const group of groups) next[group.kind] += 1;
    return next;
  }, [groups]);

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

  const visibleGroups = useMemo(
    () => groups.filter((group) => activeKind !== 'aih' && group.kind === activeKind),
    [groups, activeKind]
  );

  const operate = useCallback(async (
    record: NativeResourceManagedRecord,
    action: ManagedNativeAction
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

  const runSingle = useCallback(async (record: NativeResourceManagedRecord, action: ManagedNativeAction) => {
    const ok = await operate(record, action);
    if (ok) {
      message.success(`${record.id} · ${resourceOwner(record)} ${action === 'enable' ? '已启用' : action === 'disable' ? '已停用' : action === 'remove' ? '已移除' : '连接检查完成'}`);
      if (action === 'remove') setDetailGroup(null);
    }
    return ok;
  }, [operate]);

  const runBulk = useCallback(async (group: NativeResourceGroup, action: ManagedNativeAction) => {
    const targets = nativeActionTargets(group, action);
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
        message.warning(`${nativeActionLabel(action, targets.length)}完成 ${targets.length - failed.length}/${targets.length}；${reason.reason instanceof Error ? reason.reason.message : '部分宿主失败'}`);
      } else {
        message.success(`${group.id} ${nativeActionLabel(action, targets.length)}完成`);
      }
      await load();
    } finally {
      setBulkBusy('');
    }
  }, [load]);

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-native-resources">
      <ToolkitPanelHeader
        titleId="toolkit-native-resources"
        title="插件与资源"
        subtitle="按类型管理原生插件、Skill、MCP 及 AIH 能力插件的安装与启停。"
        extra={activeKind !== 'aih' ? (
          <Space wrap size={8}>
            <Button icon={<PlusOutlined />} type="primary" onClick={() => setInstallOpen(true)}>
              安装资源
            </Button>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              重新探测
            </Button>
          </Space>
        ) : null}
      />

      {loadError ? (
        <InlineNote
          tone="error"
          description={loadError}
          action={<Button size="small" onClick={() => void load()}>重试</Button>}
        >
          原生资源读取失败
        </InlineNote>
      ) : null}

      {loading && !report ? (
        <HudStateView variant="loading" code="RESOURCES // PROBE" title="正在探测已安装资源..." compact />
      ) : (
        <Tabs
          className="toolkit-native-resource-tabs"
          activeKey={activeKind}
          onChange={(value) => setActiveKind(value as ResourceTab)}
          items={[
            ...RESOURCE_KINDS.map((kind) => ({
              key: kind,
              label: (
                <span>
                  {KIND_ICONS[kind]} {KIND_LABELS[kind]}
                  <Tag className="toolkit-native-resource-count">{counts[kind]}</Tag>
                </span>
              ),
              children: (
                <SettingSection
                  title={kind === 'skill' ? 'Skill 仓与已安装' : `${KIND_LABELS[kind]}列表`}
                  description={kind === 'skill'
                    ? '从内置或用户仓安装 Skill，并按 Provider 逐项启停；下方为已安装投影。'
                    : '按资源汇总各宿主投影，支持批量启停或进入详情逐项管理。'}
                  status={(
                    <SettingStatusTag
                      status={counts[kind] ? 'saved' : 'unset'}
                      label={counts[kind] ? `已安装 ${counts[kind]} 项` : '未安装'}
                      compact
                    />
                  )}
                >
                  {kind === 'skill' ? (
                    <NativeResourceSkillRepo report={report} onChanged={load} />
                  ) : null}
                  <div style={{ padding: '12px 0' }}>
                    {visibleGroups.length ? (
                      <div className="toolkit-native-grid">
                        {visibleGroups.map((group) => (
                          <NativeResourceGroupCard
                            key={group.key}
                            group={group}
                            icon={KIND_ICONS[group.kind]}
                            busy={busy}
                            bulkBusy={bulkBusy}
                            onOpenDetail={setDetailGroup}
                            onBulkAction={(target, action) => void runBulk(target, action)}
                          />
                        ))}
                      </div>
                    ) : (
                      <ToolkitEmptyState
                        title={`当前没有已安装的${KIND_LABELS[kind]}`}
                        description="从内置源、本地目录或 URL 导入安装到指定 Provider / 宿主。"
                        action={(
                          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setInstallOpen(true)}>
                            安装{KIND_LABELS[kind]}
                          </Button>
                        )}
                      />
                    )}
                  </div>
                </SettingSection>
              )
            })),
            {
              key: 'aih',
              label: <span><ExperimentOutlined /> AIH 能力插件</span>,
              children: <AihPluginPanel />
            }
          ]}
        />
      )}

      <NativeResourceDetailModal
        group={detailGroup}
        busy={busy}
        onClose={() => setDetailGroup(null)}
        onAction={runSingle}
      />
      <NativeResourceInstallModal
        open={installOpen}
        report={report}
        initialKind={activeKind === 'aih' ? 'plugin' : activeKind}
        onClose={() => setInstallOpen(false)}
        onInstalled={(kind) => {
          setActiveKind(kind);
          void load();
        }}
      />
    </section>
  );
}
