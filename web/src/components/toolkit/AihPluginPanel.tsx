import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Collapse, Empty, Space, Tag, Typography, message } from 'antd';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import AihPluginInstallModal from './AihPluginInstallModal';
import type {
  AihPluginDoctorReport,
  AihPluginInstalled,
  AihPluginInstance,
  AihPluginReport
} from '@/types';

interface AihPluginGroup {
  pluginId: string;
  versions: AihPluginInstalled[];
  active?: AihPluginInstalled;
  instance?: AihPluginInstance;
  others: AihPluginInstalled[];
}

function compareVersion(left: string, right: string): number {
  return right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' });
}

export default function AihPluginPanel() {
  const [report, setReport] = useState<AihPluginReport | null>(null);
  const [doctor, setDoctor] = useState<AihPluginDoctorReport | null>(null);
  const [busy, setBusy] = useState('');
  const [installOpen, setInstallOpen] = useState(false);

  const load = useCallback(async () => {
    setBusy('load');
    try {
      const [nextReport, nextDoctor] = await Promise.all([
        toolkitAPI.getAihPlugins(),
        toolkitAPI.getAihPluginDoctor()
      ]);
      setReport(nextReport);
      setDoctor(nextDoctor);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'AIH 插件状态读取失败');
    } finally {
      setBusy('');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const operate = async (action: 'enable' | 'disable' | 'uninstall', input: Record<string, unknown>) => {
    setBusy(action);
    try {
      await toolkitAPI.operateAihPlugin(action, input);
      message.success(`AIH 插件${action === 'enable' ? '已启用' : action === 'disable' ? '已停用' : '已卸载'}`);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'AIH 插件操作失败');
    } finally {
      setBusy('');
    }
  };

  const installed = report?.installed || [];
  const instances = report?.instances || [];
  // 按 pluginId 聚合：当前实例版本作为主卡，旧版本收进折叠区，避免所有版本平铺。
  const groups = useMemo<AihPluginGroup[]>(() => {
    const byId = new Map<string, AihPluginGroup>();
    for (const plugin of installed) {
      const group = byId.get(plugin.pluginId) || { pluginId: plugin.pluginId, versions: [], others: [] };
      if (!group.versions.some((item) => item.version === plugin.version)) {
        group.versions.push(plugin);
      }
      byId.set(plugin.pluginId, group);
    }
    for (const instance of instances) {
      const group = byId.get(instance.pluginId) || { pluginId: instance.pluginId, versions: [], others: [] };
      if (!group.instance || (instance.enabled && !group.instance.enabled)) group.instance = instance;
      byId.set(instance.pluginId, group);
    }
    const result = Array.from(byId.values());
    for (const group of result) {
      group.versions.sort((left, right) => compareVersion(left.version, right.version));
      const activeVersion = group.instance?.version;
      group.active = group.versions.find((item) => item.version === activeVersion) || group.versions[0];
      group.others = group.versions.filter((item) => item.version !== group.active?.version);
    }
    return result.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  }, [installed, instances]);
  // 同一个插件的多个安装版本会重复列出同一贡献项；目录只展示一份，并优先保留活跃版本。
  const contributionCatalog = useMemo(() => {
    const byKey = new Map<string, AihPluginDoctorContribution>();
    for (const item of doctor?.contributions || []) {
      const key = `${item.pluginId}:${item.contributionId}`;
      const previous = byKey.get(key);
      if (!previous || (item.active && !previous.active)) byKey.set(key, item);
    }
    return Array.from(byKey.values()).sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1;
      if (left.capability !== right.capability) return left.capability.localeCompare(right.capability);
      return `${left.pluginId}:${left.contributionId}`.localeCompare(`${right.pluginId}:${right.contributionId}`);
    });
  }, [doctor]);
  const capabilityCatalog = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of contributionCatalog) {
      counts.set(item.capability, (counts.get(item.capability) || 0) + 1);
    }
    return Array.from(counts.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [contributionCatalog]);
  const signatureTag = (signature?: { status?: string; keyId?: string }) => {
    if (signature?.status === 'signed') return <Tag color="success">已签名</Tag>;
    if (signature?.status === 'untrusted') return <Tag color="warning">签名未验证</Tag>;
    return <Tag>未签名</Tag>;
  };
  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-aih-plugins">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">AIH CAPABILITY PLUGINS</div>
          <h2 id="toolkit-aih-plugins">AIH 能力插件</h2>
          <Typography.Text type="secondary">运行在 AIH 宿主内的签名插件，通过 contributes 声明能力槽；与 Provider / Harness 内执行的原生插件不是同一平面。</Typography.Text>
        </div>
        <Space>
          <Button icon={<PlusOutlined />} type="primary" onClick={() => setInstallOpen(true)}>安装</Button>
          <Button icon={<ReloadOutlined />} loading={busy === 'load'} onClick={() => void load()}>重新探测</Button>
        </Space>
      </header>
      {!groups.length ? <Empty description="当前没有已安装的 AIH 插件" /> : null}
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {groups.map((group) => {
          const plugin = group.active;
          const instance = group.instance;
          const enabled = Boolean(instance?.enabled);
          const stateLabel = instance ? (enabled ? '运行中' : '已停用') : '未运行';
          return (
            <Card
              key={group.pluginId}
              size="small"
              title={(
                <Space wrap>
                  <strong>{group.pluginId}</strong>
                  {plugin ? <Tag>{plugin.version}</Tag> : instance ? <Tag>{instance.version}</Tag> : null}
                  <Tag color="processing">{plugin?.kind || 'capability'}</Tag>
                  {plugin ? signatureTag(plugin.signature) : null}
                  {group.others.length ? <Tag>{group.others.length} 个旧版本</Tag> : null}
                </Space>
              )}
            >
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Text type="secondary">
                  贡献项：{plugin?.contributes?.length ? plugin.contributes.join(' · ') : '未声明'}
                </Typography.Text>
                <Space wrap>
                  <Tag icon={<CheckCircleOutlined />} color={enabled ? 'success' : 'default'}>{stateLabel}</Tag>
                  <Typography.Text type="secondary">revision {report?.revision ?? '-'}</Typography.Text>
                  {instance ? (
                    <>
                      <Button size="small" icon={enabled ? <PauseCircleOutlined /> : <PlayCircleOutlined />} loading={busy === (enabled ? 'disable' : 'enable')} onClick={() => void operate(enabled ? 'disable' : 'enable', { instanceId: instance.instanceId })}>{enabled ? '停用' : '启用'}</Button>
                      <Button size="small" danger icon={<DeleteOutlined />} loading={busy === 'uninstall'} onClick={() => void operate('uninstall', { pluginId: group.pluginId, version: instance.version })}>卸载</Button>
                    </>
                  ) : null}
                </Space>
                {group.others.length ? (
                  <Collapse
                    ghost
                    size="small"
                    items={[{
                      key: 'versions',
                      label: `其他已安装版本（${group.others.length}）`,
                      children: (
                        <Space direction="vertical" size={4}>
                          {group.others.map((item) => (
                            <Space key={item.version} wrap size={6}>
                              <Tag>{item.version}</Tag>
                              {signatureTag(item.signature)}
                              <Button
                                size="small"
                                danger
                                icon={<DeleteOutlined />}
                                loading={busy === 'uninstall'}
                                onClick={() => void operate('uninstall', { pluginId: group.pluginId, version: item.version })}
                              >移除</Button>
                            </Space>
                          ))}
                        </Space>
                      )
                    }]}
                  />
                ) : null}
              </Space>
            </Card>
          );
        })}
      </Space>
      {capabilityCatalog.length ? (
        <Card size="small" title="声明的能力槽">
          <Space wrap size={[6, 6]}>
            {capabilityCatalog.map(([capability, count]) => (
              <Tag key={capability}>{capability} × {count}</Tag>
            ))}
          </Space>
        </Card>
      ) : null}
      {contributionCatalog.length ? (
        <Card size="small" title="贡献项目录">
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {contributionCatalog.map((item) => {
              const scope = item.scope
                ? Object.entries(item.scope)
                  .flatMap(([key, values]) => (values?.length ? [`${key}:${values.join('|')}`] : []))
                  .join(' ')
                : '';
              return (
                <Space wrap key={`${item.pluginId}:${item.contributionId}`} size={6}>
                  <Tag color="processing">{item.capability}</Tag>
                  <Tag color={item.active ? 'success' : 'default'}>{item.active ? '活跃' : '未激活'}</Tag>
                  <Typography.Text code>{item.contributionId}</Typography.Text>
                  <Typography.Text type="secondary">
                    {item.pluginId} · order {item.order} · {item.failurePolicy}
                    {scope ? ` · scope ${scope}` : ''}
                    {item.calls > 0
                      ? ` · 调用 ${item.calls} · 失败 ${item.failures} · 最近 ${item.lastDurationMs}ms`
                      : ' · 尚未调用'}
                  </Typography.Text>
                  {item.lastError ? <Tag color="error">{item.lastError}</Tag> : null}
                </Space>
              );
            })}
          </Space>
        </Card>
      ) : null}
      {doctor ? <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12 }}>Doctor：{doctor.ok ? '健康' : `${doctor.issues?.length || 0} 个问题`}；runtime {String(doctor.runtime?.state || 'unknown')}</Typography.Text> : null}
      <AihPluginInstallModal
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        onInstalled={() => void load()}
      />
    </section>
  );
}
