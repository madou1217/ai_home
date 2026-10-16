import { useCallback, useEffect, useMemo, useState } from 'react';
import { Input, InputNumber, Select } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { HudSection, KeyValue, TelemetryGrid, TelemetryTile } from '@/mobile/ui';
import { edgeProxyAPI } from '@/components/toolkit/edge-proxy/edge-proxy-api';
import {
  EDGE_NGINX_MODES,
  EDGE_PROVIDER_META,
  describeApplyResult,
  describeEdgeError,
  edgeInstallHint
} from '@/components/toolkit/edge-proxy/edge-proxy-presentation';
import type { EdgeApplyResult, EdgeNginxMode, EdgePlan, EdgeProvider, EdgeStatus } from '@/components/toolkit/edge-proxy/types';
import { ActionButton, InlineError, MonoBlock, Note, PanelToolbar, StatusText } from './toolkit-parts';

const PROVIDERS: EdgeProvider[] = ['nginx', 'caddy', 'frp'];

/** 入口与转发（移动端）：与桌面同名同位置，看本机 nginx / caddy / frp 现状并落一次改动。 */
export default function EdgeForwardingPanel({ planOnly = false }: { planOnly?: boolean }) {
  const [status, setStatus] = useState<EdgeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [provider, setProvider] = useState<EdgeProvider>('nginx');
  const [domain, setDomain] = useState('');
  const [mode, setMode] = useState<EdgeNginxMode>('split');
  const [remotePort, setRemotePort] = useState<number | null>(null);
  const [plan, setPlan] = useState<EdgePlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<EdgeApplyResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setStatus(await edgeProxyAPI.status());
    } catch (error_: unknown) {
      setError(error_ instanceof Error ? error_.message : '读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const platform = status?.platform || '';
  const installedCount = useMemo(
    () => PROVIDERS.filter((item) => status?.providers?.[item]?.installed).length,
    [status]
  );
  const planInput = useMemo(() => ({
    provider,
    domain: domain.trim() || undefined,
    mode: provider === 'nginx' ? mode : undefined,
    remotePort: provider === 'frp' && remotePort ? remotePort : undefined
  }), [provider, domain, mode, remotePort]);

  const ready = provider === 'frp' ? Boolean(remotePort) : Boolean(domain.trim());

  // 参数齐了就自动预览（与桌面同一套：不用先点一次「生成计划」）。
  useEffect(() => {
    if (!ready) {
      setPlan(null);
      setPlanError('');
      return undefined;
    }
    setApplyResult(null);
    let alive = true;
    const timer = setTimeout(() => {
      setPlanLoading(true);
      void (async () => {
        try {
          const data = await edgeProxyAPI.plan(planInput);
          if (!alive) return;
          if (data.ok === false || !data.plan) {
            setPlan(null);
            setPlanError(describeEdgeError(data.error, platform));
          } else {
            setPlan(data.plan);
            setPlanError('');
          }
        } catch (error_: unknown) {
          if (!alive) return;
          setPlan(null);
          setPlanError(error_ instanceof Error ? error_.message : '预览失败');
        } finally {
          if (alive) setPlanLoading(false);
        }
      })();
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [ready, planInput, platform]);

  const applyPlan = useCallback(async () => {
    setApplying(true);
    try {
      const data = await edgeProxyAPI.apply({ ...planInput, reload: true });
      setApplyResult(data);
      if (data.ok) void load();
    } catch (error_: unknown) {
      setApplyResult({ ok: false, error: 'edge_request_failed', message: error_ instanceof Error ? error_.message : '写入失败' });
    } finally {
      setApplying(false);
    }
  }, [planInput, load]);

  const applyLine = applyResult ? describeApplyResult(applyResult) : null;

  return (
    <>
      <PanelToolbar
        refreshLabel="重新探测本机入口"
        refreshing={loading}
        onRefresh={() => void load()}
        status={status ? (
          <StatusText tone={installedCount ? 'ok' : 'warn'} live={loading}>
            {installedCount} / {PROVIDERS.length} 已安装
          </StatusText>
        ) : null}
      />

      {error ? <InlineError title="本机入口探测失败" detail={error} onRetry={() => void load()} retrying={loading} /> : null}

      <TelemetryGrid>
        <TelemetryTile label="转发目标" value={status ? `:${status.aihPort}` : '—'} tone="info" sub="跟随 AIH 端口" />
        <TelemetryTile label="已安装" value={`${installedCount}/${PROVIDERS.length}`} tone={installedCount ? 'ok' : 'warn'} sub="只按真实探测" />
      </TelemetryGrid>

      {PROVIDERS.map((item) => {
        const info = status?.providers?.[item];
        if (planOnly) return null;
        return (
          <HudSection key={item} code={item.toUpperCase()} title={EDGE_PROVIDER_META[item].label}>
            <KeyValue
              rows={[
                {
                  key: 'installed',
                  label: '状态',
                  value: info?.installed ? `已安装${info.version ? ` ${info.version}` : ''}` : '未安装',
                  tone: info?.installed ? 'ok' : 'warn'
                },
                { key: 'role', label: '用途', value: EDGE_PROVIDER_META[item].role },
                { key: 'capability', label: '能力', value: EDGE_PROVIDER_META[item].capability },
                {
                  key: 'config',
                  label: '配置',
                  value: `${info?.configDir || info?.configPath || '未探测到'}${info?.writable === false ? '（不可写）' : ''}`,
                  mono: true
                }
              ]}
            />
            {info && !info.installed ? (
              <MonoBlock label="安装线索">{edgeInstallHint(item, platform)}</MonoBlock>
            ) : null}
          </HudSection>
        );
      })}

      <HudSection code="PLAN" title="将要写入的内容">
        <Select
          style={{ width: '100%' }}
          value={provider}
          onChange={(value) => {
            setProvider(value);
            setPlan(null);
            setApplyResult(null);
          }}
          options={PROVIDERS.map((item) => ({ value: item, label: EDGE_PROVIDER_META[item].label }))}
        />
        {provider !== 'frp' ? (
          <Input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="域名，例如 aih.example.com" />
        ) : null}
        {provider === 'nginx' ? (
          <Select
            style={{ width: '100%' }}
            value={mode}
            onChange={(value) => setMode(value)}
            options={EDGE_NGINX_MODES.map((item) => ({ value: item.value, label: item.label }))}
          />
        ) : null}
        {provider === 'frp' ? (
          <InputNumber
            style={{ width: '100%' }}
            value={remotePort}
            onChange={setRemotePort}
            placeholder="VPS 远端端口"
          />
        ) : null}
        {!ready ? (
          <Note tone="info">{provider === 'frp' ? '填上远端端口就会显示要写的内容。' : '填上域名就会显示要写的内容。'}</Note>
        ) : null}
        {ready && planLoading && !plan ? <Note tone="info">正在算要写哪些文件…</Note> : null}
        {planError ? <InlineError title="生成失败" detail={planError} /> : null}
        {plan ? (
          <>
            <Note tone="info" title={plan.summary}>{plan.notes?.join('；')}</Note>
            {plan.files.map((file) => (
              <MonoBlock key={file.path} label={file.path}>{file.content}</MonoBlock>
            ))}
            {planOnly ? null : (
              <ActionButton
                icon={<SafetyCertificateOutlined />}
                label="写入并重载"
                tone="primary"
                loading={applying}
                onClick={() => void applyPlan()}
              />
            )}
          </>
        ) : null}
        {planOnly ? (
          <Note tone="info">写入、回滚与状态在「应用与集成 → 入口与转发」里做；这里只生成计划。</Note>
        ) : null}
        {applyLine ? (
          <Note tone={applyLine.tone === 'success' ? 'info' : 'err'} title={applyLine.text}>
            {applyLine.detail}
          </Note>
        ) : null}
      </HudSection>
    </>
  );
}
