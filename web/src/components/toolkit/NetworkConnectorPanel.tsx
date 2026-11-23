import { useCallback, useEffect, useState } from 'react';
import { Card, Empty, Input, Popconfirm, Space, Tag, Typography, message } from 'antd';
import {
  ApiOutlined,
  CheckCircleOutlined,
  DisconnectOutlined,
  LinkOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { toolkitAPI } from '@/services/api';
import { proxyServeAPI } from '@/features/proxy-serve/proxy-serve-api';
import { openExternalUrl } from '@/services/open-external-url';
import type {
  NetworkConnectorConnectivityMode,
  NetworkConnectorInputKind,
  NetworkConnectorOperation,
  NetworkConnectorOperationResult,
  NetworkConnectorView
} from '@/types';

const CONNECTIVITY_LABELS: Record<NetworkConnectorConnectivityMode, string> = {
  'direct-p2p': '直连 P2P',
  'peer-relay': '对等中继',
  'derp-relay': 'DERP/云中继',
  'outbound-tunnel': '出站隧道',
  'wireguard-tunnel': 'WireGuard 隧道',
  unavailable: '不可用',
  unknown: '已连接，路径未知'
};

const INPUT_OPERATIONS = new Set(['configure', 'connect', 'login', 'authenticate', 'auth']);
const CONFIRM_OPERATIONS = new Set(['install', 'uninstall', 'enable', 'disable', 'configure']);

interface ConfigField {
  key: string;
  description?: string;
  secret: boolean;
  /** 插件声明该字段可以填 AIH 本机代理 URL（schema 的 x-aih-proxy）。 */
  proxy: boolean;
}

function actionLabel(operation: NetworkConnectorOperation) {
  return operation.label || operation.id;
}

function requiresConfirmation(operation: NetworkConnectorOperation) {
  if (CONFIRM_OPERATIONS.has(operation.id)) return true;
  return operation.confirmation === 'required';
}

function operationInputKind(
  operation: NetworkConnectorOperation,
  view: NetworkConnectorView
): NetworkConnectorInputKind {
  if (operation.inputKind) return operation.inputKind;
  if (operation.id === 'configure') {
    if (view.connector.config?.secretFields?.length) return 'secret';
    if (view.connector.config?.schema) return 'custom';
  }
  return 'none';
}

function inputKey(view: NetworkConnectorView, operation: NetworkConnectorOperation) {
  return `${view.connector.contributionId}:${operation.id}`;
}

function configFields(view: NetworkConnectorView): ConfigField[] {
  const schema = view.connector.config?.schema as { properties?: Record<string, unknown> } | undefined;
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return [];
  const secretFields = new Set(view.connector.config?.secretFields || []);
  return Object.entries(properties)
    .filter(([, value]) => value && typeof value === 'object')
    .map(([key, value]) => {
      const description = (value as { description?: unknown }).description;
      const proxy = (value as { 'x-aih-proxy'?: unknown })['x-aih-proxy'];
      return {
        key,
        description: typeof description === 'string' ? description : undefined,
        secret: secretFields.has(key),
        proxy: proxy === true
      };
    });
}

function operationDisabled(
  operation: NetworkConnectorOperation,
  status: NetworkConnectorView['status']
) {
  if (!status) {
    return INPUT_OPERATIONS.has(operation.id) || CONFIRM_OPERATIONS.has(operation.id);
  }
  switch (operation.id) {
    case 'install':
      return status.installed;
    case 'uninstall':
      return !status.installed;
    case 'enable':
      return !status.installed || status.enabled;
    case 'disable':
      return !status.installed || !status.enabled;
    case 'configure':
      return false;
    case 'connect':
    case 'login':
    case 'authenticate':
    case 'auth':
      return !status.installed;
    default:
      return false;
  }
}

function resultText(result: NetworkConnectorOperationResult) {
  return result.ok ? (result.message || '操作已完成') : (result.message || '操作失败');
}

export default function NetworkConnectorPanel() {
  const [connectors, setConnectors] = useState<NetworkConnectorView[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [busySince, setBusySince] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [configValues, setConfigValues] = useState<Record<string, Record<string, string>>>({});
  const [results, setResults] = useState<Record<string, NetworkConnectorOperationResult>>({});
  const [proxyBusy, setProxyBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setConnectors(await toolkitAPI.getNetworkConnectors());
    } catch (error) {
      message.error(error instanceof Error ? error.message : '网络连接器状态读取失败');
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
      const fields = configFields(view);
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
        const kind = operationInputKind(operation, view);
        const raw = (inputs[inputKey(view, operation)] || '').trim();
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

  // 智能代理注入：连接器字段声明 x-aih-proxy 时，可一键启动本机代理入口并填入
  // 带租约认证的 HTTP URL，让安装/连接命令走 AIH 出口，而不是要求用户自己找代理。
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

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-network-connectors">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">EXTERNAL NETWORK CONNECTORS</div>
          <h2 id="toolkit-network-connectors">网络连接器</h2>
          <Typography.Text type="secondary">
            Tailscale、WireGuard、Cloudflare Tunnel 等通过仓外插件提供；插件生命周期和连接器自身的安装/启停分开管理。
          </Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>重新探测</Button>
      </header>

      {connectors.length ? (
        <Space wrap size={6} style={{ marginBottom: 4 }}>
          <Typography.Text type="secondary">快速定位连接器：</Typography.Text>
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
        </Space>
      ) : null}
      {!loading && !connectors.length ? <Empty description="当前没有启用网络连接器插件" /> : null}
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {connectors.map((view) => {
          const connector = view.connector;
          const status = view.status;
          const mode = status?.connectivity?.mode;
          const fields = configFields(view);
          const result = results[connector.id];
          const activeOperation = busy.startsWith(`${connector.contributionId}:`)
            ? connector.operations.find((item) => busy === inputKey(view, item))
            : undefined;
          return (
            <Card
              key={`${connector.instanceId}:${connector.contributionId}`}
              id={`connector-${connector.id}`}
              size="small"
              style={{ scrollMarginTop: 72 }}
              title={<Space><ApiOutlined /><strong>{connector.name || connector.id}</strong>{connector.transport ? <Tag>{connector.transport}</Tag> : null}</Space>}
            >
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {connector.description ? <Typography.Text type="secondary">{connector.description}</Typography.Text> : null}
                {connector.setup ? (
                  <div
                    style={{
                      border: '1px solid var(--color-border)',
                      borderRadius: 8,
                      padding: '8px 10px',
                      background: 'var(--color-surface)'
                    }}
                  >
                    <Typography.Text strong>{connector.name || connector.id} 接入步骤</Typography.Text>
                    {connector.setup.summary ? (
                      <div><Typography.Text type="secondary">{connector.setup.summary}</Typography.Text></div>
                    ) : null}
                    {connector.setup.steps?.length ? (
                      <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>
                        {connector.setup.steps.map((step, index) => (
                          <li key={`${connector.id}:step:${index}`}>
                            <Typography.Text>{step}</Typography.Text>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    {connector.setup.links?.length ? (
                      <Space wrap style={{ marginTop: 6 }}>
                        {connector.setup.links.map((link) => (
                          <Button
                            key={`${connector.id}:link:${link.label}`}
                            size="small"
                            icon={<LinkOutlined />}
                            onClick={() => void openLink(link.url)}
                          >
                            {link.label}
                          </Button>
                        ))}
                      </Space>
                    ) : null}
                  </div>
                ) : null}
                <Space wrap>
                  <Tag icon={status?.running ? <CheckCircleOutlined /> : <DisconnectOutlined />} color={status?.running ? 'success' : 'default'}>
                    {status?.state || '状态未知'}
                  </Tag>
                  {mode ? <Tag icon={<SafetyCertificateOutlined />}>{CONNECTIVITY_LABELS[mode] || mode}</Tag> : null}
                  {status?.version ? <Tag>{status.version}</Tag> : null}
                  {status?.connectivity?.latencyMs ? <Typography.Text type="secondary">{status.connectivity.latencyMs} ms</Typography.Text> : null}
                </Space>
                {status?.message ? <Typography.Text type="secondary">{status.message}</Typography.Text> : null}
                {status?.connectivity?.evidence ? (
                  <InlineNote tone="info" description={`${status.connectivity.evidence.source || '未标注来源'} · ${status.connectivity.evidence.path || '路径未知'}`}>
                    连通性证据：{status.connectivity.evidence.transport || '传输方式未标注'}
                  </InlineNote>
                ) : null}
                {view.error ? <InlineNote tone="error">连接器状态读取失败：{view.error}</InlineNote> : null}
                {activeOperation ? (
                  <InlineNote tone="info">
                    正在{actionLabel(activeOperation)}，安装/卸载可能需要数分钟… 已用 {Math.max(0, Math.floor((now - busySince) / 1000))}s
                  </InlineNote>
                ) : null}
                <Space wrap>
                  {connector.operations.map((operation) => {
                    const key = inputKey(view, operation);
                    const confirmed = requiresConfirmation(operation);
                    const button = (
                      <Button
                        key={operation.id}
                        size="small"
                        loading={busy === key}
                        disabled={Boolean(busy) || operationDisabled(operation, status)}
                        onClick={confirmed ? undefined : () => void operate(view, operation)}
                      >
                        {actionLabel(operation)}
                      </Button>
                    );
                    return requiresConfirmation(operation) ? (
                      <Popconfirm
                        key={operation.id}
                        title={`确认${actionLabel(operation)}？`}
                        description="该操作可能安装、修改或停用外部网络组件。"
                        okText="确认执行"
                        cancelText="取消"
                        okButtonProps={{ danger: ['uninstall', 'disable'].includes(operation.id) }}
                        onConfirm={() => void operate(view, operation, true)}
                      >
                        {button}
                      </Popconfirm>
                    ) : button;
                  })}
                </Space>
                {fields.length ? (
                  <div>
                    <Typography.Text type="secondary">
                      连接器配置：敏感字段只提交给插件，状态列表不回显。
                    </Typography.Text>
                    <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 6 }}>
                      {fields.map((field) => (
                        <div key={field.key}>
                          <Typography.Text>{field.key}</Typography.Text>
                          {field.description ? <Typography.Text type="secondary"> · {field.description}</Typography.Text> : null}
                          {field.proxy ? (
                            <div style={{ marginTop: 4 }}>
                              <Button
                                size="small"
                                loading={proxyBusy === `${connector.id}:${field.key}`}
                                disabled={Boolean(proxyBusy)}
                                onClick={() => void applyAihProxy(connector.id, field.key)}
                              >
                                使用 AIH 本机代理
                              </Button>
                              <Typography.Text type="secondary">
                                {' '}自动启动本机代理入口并填入出口 URL，供安装/连接命令使用。
                              </Typography.Text>
                            </div>
                          ) : null}
                          {field.secret ? (
                            <Input.Password
                              placeholder="输入敏感值"
                              value={(configValues[connector.id] || {})[field.key] || ''}
                              onChange={(event) => setConfigValues((current) => ({
                                ...current,
                                [connector.id]: { ...(current[connector.id] || {}), [field.key]: event.target.value }
                              }))}
                            />
                          ) : (
                            <Input
                              value={(configValues[connector.id] || {})[field.key] || ''}
                              onChange={(event) => setConfigValues((current) => ({
                                ...current,
                                [connector.id]: { ...(current[connector.id] || {}), [field.key]: event.target.value }
                              }))}
                            />
                          )}
                        </div>
                      ))}
                    </Space>
                  </div>
                ) : null}
                {connector.operations.map((operation) => {
                  const inputKind = operationInputKind(operation, view);
                  if (inputKind === 'none') return null;
                  if (operation.id === 'configure' && fields.length) return null;
                  const key = inputKey(view, operation);
                  return (
                    <div key={`${key}:input`}>
                      <Typography.Text type="secondary">
                        {actionLabel(operation)} 的插件自定义输入：仅在执行该操作时发送，不会写入状态列表。
                      </Typography.Text>
                      {inputKind === 'secret' ? (
                        <Input.Password
                          placeholder="输入敏感值"
                          value={inputs[key] || ''}
                          onChange={(event) => setInputs((current) => ({ ...current, [key]: event.target.value }))}
                        />
                      ) : (
                        <Input.TextArea
                          autoSize={{ minRows: 2, maxRows: 5 }}
                          placeholder="输入 JSON 或插件自定义内容"
                          value={inputs[key] || ''}
                          onChange={(event) => setInputs((current) => ({ ...current, [key]: event.target.value }))}
                        />
                      )}
                    </div>
                  );
                })}
                {result ? (
                  <div>
                    <Typography.Text type={result.ok ? 'success' : 'danger'}>{resultText(result)}</Typography.Text>
                    {result.links?.length ? (
                      <Space wrap style={{ marginTop: 6 }}>
                        {result.links.map((link) => (
                          <Button
                            key={`${connector.id}:result-link:${link.label}`}
                            size="small"
                            icon={<LinkOutlined />}
                            onClick={() => void openLink(link.url)}
                          >
                            {link.label}
                          </Button>
                        ))}
                      </Space>
                    ) : null}
                    {result.output?.length ? (
                      <details style={{ marginTop: 6 }}>
                        <summary style={{ cursor: 'pointer' }}>操作日志（{result.output.length} 行）</summary>
                        <pre style={{ margin: '6px 0 0', maxHeight: 220, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap' }}>
                          {result.output.join('\n')}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </Space>
            </Card>
          );
        })}
      </Space>
    </section>
  );
}
