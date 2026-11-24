import { useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import { ApiOutlined, ReloadOutlined } from '@ant-design/icons';
import HudStateView from '@/components/hud/HudStateView';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { toolkitAPI } from '@/services/api';
import { proxyServeAPI } from '@/features/proxy-serve/proxy-serve-api';
import { openExternalUrl } from '@/services/open-external-url';
import type {
  NetworkConnectorOperation,
  NetworkConnectorOperationResult,
  NetworkConnectorView
} from '@/types';
import NetworkConnectorCard, {
  connectorConfigFields,
  connectorInputKey,
  connectorOperationInputKind
} from './NetworkConnectorCard';
import ToolkitEmptyState from './ToolkitEmptyState';
import ToolkitPanelHeader from './ToolkitPanelHeader';

function resultText(result: NetworkConnectorOperationResult) {
  return result.ok ? (result.message || '操作已完成') : (result.message || '操作失败');
}

export default function NetworkConnectorPanel() {
  const [connectors, setConnectors] = useState<NetworkConnectorView[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [busySince, setBusySince] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [configValues, setConfigValues] = useState<Record<string, Record<string, string>>>({});
  const [results, setResults] = useState<Record<string, NetworkConnectorOperationResult>>({});
  const [proxyBusy, setProxyBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      setConnectors(await toolkitAPI.getNetworkConnectors());
    } catch (error) {
      const detail = error instanceof Error ? error.message : '网络连接器状态读取失败';
      setLoadError(detail);
      message.error(detail);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const focusConnector = (connectorId: string) => {
    const target = document.getElementById(`connector-${connectorId}`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // 深链：/ui/toolkit?panel=network-access#tailscale 或 ?connector=tailscale
  useEffect(() => {
    if (!connectors.length) return;
    const hash = window.location.hash.replace(/^#/, '').trim();
    const query = new URLSearchParams(window.location.search).get('connector') || '';
    const key = hash || query;
    if (!key) return;
    const match = connectors.find(
      (view) => view.connector.id === key || view.connector.name === key
    );
    if (match) {
      window.setTimeout(() => focusConnector(match.connector.id), 50);
    }
  }, [connectors]);

  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const operate = async (view: NetworkConnectorView, operation: NetworkConnectorOperation, confirmed = false) => {
    const key = `${view.connector.contributionId}:${operation.id}`;
    const connectorId = view.connector.id;
    setBusy(key);
    setBusySince(Date.now());
    try {
      const fields = connectorConfigFields(view);
      let input: unknown = {};
      if (operation.id === 'configure' && fields.length) {
        const values = configValues[connectorId] || {};
        const next: Record<string, string> = {};
        for (const field of fields) {
          const value = (values[field.key] || '').trim();
          if (value) next[field.key] = value;
        }
        input = next;
      } else {
        const kind = connectorOperationInputKind(operation, view);
        const raw = (inputs[connectorInputKey(view, operation)] || '').trim();
        if (kind === 'secret' && raw) {
          input = { value: raw };
        } else if (kind === 'custom' && raw) {
          try {
            input = JSON.parse(raw) as unknown;
          } catch (_error) {
            input = { value: raw };
          }
        }
      }
      const result = await toolkitAPI.operateNetworkConnector(connectorId, operation.id, input, confirmed);
      setResults((current) => ({ ...current, [connectorId]: result }));
      message[result.ok ? 'success' : 'error'](resultText(result));
      await load();
    } catch (error) {
      const detail = error instanceof Error ? error.message : '网络连接器操作失败';
      setResults((current) => ({
        ...current,
        [connectorId]: { connectorId, action: operation.id, ok: false, message: detail }
      }));
      message.error(detail);
    } finally {
      setBusy('');
      setBusySince(0);
    }
  };

  const openLink = async (url: string) => {
    try {
      await openExternalUrl(url);
    } catch (_error) {
      message.error('浏览器拦截了外部链接，请允许弹窗后重试');
    }
  };

  const applyAihProxy = async (connectorId: string, fieldKey: string) => {
    const key = `${connectorId}:${fieldKey}`;
    setProxyBusy(key);
    try {
      let session = (await proxyServeAPI.view()).session;
      if (!session.running || !session.httpUrl) {
        const started = await proxyServeAPI.start({ selector: 'auto' });
        session = started.session;
      }
      if (!session.httpUrl) throw new Error('本机代理入口未返回 URL');
      setConfigValues((current) => ({
        ...current,
        [connectorId]: { ...(current[connectorId] || {}), [fieldKey]: session.httpUrl || '' }
      }));
      message.success(`已填入 AIH 本机代理入口（出口：${session.name || '自动选择'}）`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '启动本机代理入口失败');
    } finally {
      setProxyBusy('');
    }
  };

  const elapsedSeconds = Math.max(0, Math.floor((now - busySince) / 1000));

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-network-connectors">
      <ToolkitPanelHeader
        titleId="toolkit-network-connectors"
        title="网络连接器"
        subtitle="管理外置网络插件提供的 Tailscale、WireGuard、Cloudflare Tunnel 等接入状态。"
        extra={(
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            重新探测
          </Button>
        )}
      />

      {loadError ? (
        <InlineNote
          tone="error"
          description={loadError}
          action={<Button size="small" onClick={() => void load()}>重试</Button>}
        >
          网络连接器读取失败
        </InlineNote>
      ) : null}

      {loading && !connectors.length ? (
        <HudStateView variant="loading" code="CONNECTOR // PROBE" title="正在探测网络连接器..." compact />
      ) : connectors.length ? (
        <div className="toolkit-panel-stack">
          {connectors.length > 1 ? (
            <div className="toolkit-connector-jump-bar">
              <span className="toolkit-connector-jump-label">快速定位：</span>
              {connectors.map((view) => (
                <Button
                  key={`focus:${view.connector.instanceId}:${view.connector.contributionId}`}
                  size="small"
                  icon={<ApiOutlined />}
                  onClick={() => focusConnector(view.connector.id)}
                >
                  {view.connector.name || view.connector.id}
                </Button>
              ))}
            </div>
          ) : null}

          <div className="toolkit-connector-list">
            {connectors.map((view) => (
              <NetworkConnectorCard
                key={`${view.connector.instanceId}:${view.connector.contributionId}`}
                view={view}
                busy={busy}
                busyElapsedSeconds={elapsedSeconds}
                proxyBusy={proxyBusy}
                inputs={inputs}
                configValues={configValues[view.connector.id] || {}}
                result={results[view.connector.id]}
                onInputChange={(key, value) => setInputs((current) => ({ ...current, [key]: value }))}
                onConfigValueChange={(connectorId, fieldKey, value) => setConfigValues((current) => ({
                  ...current,
                  [connectorId]: { ...(current[connectorId] || {}), [fieldKey]: value }
                }))}
                onApplyAihProxy={(connectorId, fieldKey) => void applyAihProxy(connectorId, fieldKey)}
                onOperate={(target, operation, confirmed) => void operate(target, operation, confirmed)}
                onOpenLink={(url) => void openLink(url)}
              />
            ))}
          </div>
        </div>
      ) : (
        <ToolkitEmptyState
          title="当前没有启用的网络连接器插件"
          description="安装并启用网络连接器插件后，重新探测即可在此管理连接状态。"
          action={(
            <Button type="primary" size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
              重新探测
            </Button>
          )}
        />
      )}
    </section>
  );
}
