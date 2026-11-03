import { useCallback, useEffect, useState } from 'react';
import { Card, Empty, Space, Tag, Typography, message } from 'antd';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import type { AihPluginDoctorReport, AihPluginReport, NativeResourceDemoResult } from '@/types';

function evidenceLines(result: NativeResourceDemoResult | null): string[] {
  const evidence = result?.evidence;
  if (!evidence || typeof evidence !== 'object') return [];
  const steps = Array.isArray((evidence as { steps?: unknown }).steps)
    ? (evidence as { steps: Array<Record<string, unknown>> }).steps
    : [];
  return steps.map((step) => {
    const stage = String(step.stage || 'stage');
    const passed = step.passed === true ? '通过' : '失败';
    const used = step.sharedCoreCalled === true ? '已调用 Portable Core' : '';
    return `${stage}: ${passed}${used ? `，${used}` : ''}`;
  });
}

export default function AihPluginPanel() {
  const [report, setReport] = useState<AihPluginReport | null>(null);
  const [doctor, setDoctor] = useState<AihPluginDoctorReport | null>(null);
  const [demo, setDemo] = useState<NativeResourceDemoResult | null>(null);
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

  const runDemo = async () => {
    setBusy('demo');
    try {
      const result = await toolkitAPI.runAihPluginDemo();
      setDemo(result.demo);
      message.success('AIH Portable Plugin demo 已通过');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'AIH 插件 demo 失败');
    } finally {
      setBusy('');
    }
  };

  const installed = report?.installed || [];
  const instances = report?.instances || [];
  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-aih-plugins">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">AIH SUPERVISED PLUGINS</div>
          <h2 id="toolkit-aih-plugins">AIH 插件宿主</h2>
          <Typography.Text type="secondary">这是 AIH 自有签名插件与 Host/RPC 生命周期控制面，和 Codex、Claude 等原生资源分开管理。</Typography.Text>
        </div>
        <Space>
          <Button icon={<ExperimentOutlined />} loading={busy === 'demo'} onClick={() => void runDemo()}>运行闭环 demo</Button>
          <Button icon={<ReloadOutlined />} loading={busy === 'load'} onClick={() => void load()}>重新探测</Button>
        </Space>
      </header>
      {!installed.length && !instances.length ? <Empty description="当前没有已安装的 AIH 插件" /> : null}
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {installed.map((plugin) => {
          const instance = instances.find((item) => item.pluginId === plugin.pluginId && item.version === plugin.version);
          const enabled = Boolean(instance?.enabled);
          return (
            <Card key={`${plugin.pluginId}:${plugin.version}`} size="small" title={<Space><strong>{plugin.pluginId}</strong><Tag>{plugin.version}</Tag>{plugin.signature?.status === 'signed' ? <Tag color="success">已签名</Tag> : <Tag>未签名</Tag>}</Space>}>
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
            </Card>
          );
        })}
      </Space>
      {doctor ? <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12 }}>Doctor：{doctor.ok ? '健康' : `${doctor.issues?.length || 0} 个问题`}；runtime {String(doctor.runtime?.state || 'unknown')}</Typography.Text> : null}
      {demo ? <Card size="small" title="最近一次 demo 证据" style={{ marginTop: 12 }}><Space direction="vertical" size={4}>{evidenceLines(demo).map((line) => <Typography.Text key={line}>{line}</Typography.Text>)}</Space></Card> : null}
    </section>
  );
}
