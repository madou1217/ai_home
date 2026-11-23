import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Empty, Space, Tag, Typography, message } from 'antd';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import type { AihPluginDoctorReport, AihPluginReport } from '@/types';

export default function AihPluginPanel() {
  const [report, setReport] = useState<AihPluginReport | null>(null);
  const [doctor, setDoctor] = useState<AihPluginDoctorReport | null>(null);
  const [busy, setBusy] = useState('');

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
  // 同一个插件的多个安装版本会重复列出同一贡献项；目录只展示一份。
  const contributionCatalog = useMemo(() => {
    const seen = new Set<string>();
    return (doctor?.contributions || []).filter((item) => {
      const key = `${item.pluginId}:${item.contributionId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
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
          <div className="toolkit-panel-kicker">AIH SUPERVISED PLUGINS</div>
          <h2 id="toolkit-aih-plugins">AIH 插件宿主</h2>
          <Typography.Text type="secondary">这是 AIH 自有签名插件与 Host/RPC 生命周期控制面，和 Codex、Claude 等原生资源分开管理。</Typography.Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} loading={busy === 'load'} onClick={() => void load()}>重新探测</Button>
        </Space>
      </header>
      {!installed.length && !instances.length ? <Empty description="当前没有已安装的 AIH 插件" /> : null}
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {installed.map((plugin) => {
          const instance = instances.find((item) => item.pluginId === plugin.pluginId && item.version === plugin.version);
          const enabled = Boolean(instance?.enabled);
          return (
            <Card key={`${plugin.pluginId}:${plugin.version}`} size="small" title={<Space><strong>{plugin.pluginId}</strong><Tag>{plugin.version}</Tag>{signatureTag(plugin.signature)}</Space>}>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Text type="secondary">
                  贡献项：{plugin.contributes?.length ? plugin.contributes.join(' · ') : '未声明'}
                </Typography.Text>
                <Space wrap>
                  <Tag icon={<CheckCircleOutlined />} color={enabled ? 'success' : 'default'}>{enabled ? '运行中' : '已停用'}</Tag>
                  <Typography.Text type="secondary">revision {report?.revision ?? '-'}</Typography.Text>
                  {instance ? (
                    <>
                      <Button size="small" icon={enabled ? <PauseCircleOutlined /> : <PlayCircleOutlined />} loading={busy === (enabled ? 'disable' : 'enable')} onClick={() => void operate(enabled ? 'disable' : 'enable', { instanceId: instance.instanceId })}>{enabled ? '停用' : '启用'}</Button>
                      <Button size="small" danger icon={<DeleteOutlined />} loading={busy === 'uninstall'} onClick={() => void operate('uninstall', { pluginId: plugin.pluginId, version: plugin.version })}>卸载</Button>
                    </>
                  ) : null}
                </Space>
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
                  <Typography.Text code>{item.contributionId}</Typography.Text>
                  <Typography.Text type="secondary">
                    {item.pluginId} · order {item.order} · {item.failurePolicy}
                    {scope ? ` · scope ${scope}` : ''}
                  </Typography.Text>
                </Space>
              );
            })}
          </Space>
        </Card>
      ) : null}
      {doctor ? <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12 }}>Doctor：{doctor.ok ? '健康' : `${doctor.issues?.length || 0} 个问题`}；runtime {String(doctor.runtime?.state || 'unknown')}</Typography.Text> : null}
    </section>
  );
}
