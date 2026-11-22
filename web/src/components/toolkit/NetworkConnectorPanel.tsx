import { useCallback, useEffect, useState } from 'react';
import { Card, Empty, Input, Popconfirm, Space, Tag, Typography, message } from 'antd';
import {
  ApiOutlined,
  CheckCircleOutlined,
  DisconnectOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { toolkitAPI } from '@/services/api';
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
  const [inputs, setInputs] = useState<Record<string, string>>({});

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

  const operate = async (view: NetworkConnectorView, operation: NetworkConnectorOperation, confirmed = false) => {
    const key = `${view.connector.contributionId}:${operation.id}`;
    setBusy(key);
    try {
      const kind = operationInputKind(operation, view);
      const raw = (inputs[inputKey(view, operation)] || '').trim();
      let input: unknown = {};
      if (kind === 'secret' && raw) {
        input = { value: raw };
      } else if (kind === 'custom' && raw) {
        try {
          input = JSON.parse(raw) as unknown;
        } catch (_error) {
          input = { value: raw };
        }
      }
      const result = await toolkitAPI.operateNetworkConnector(view.connector.id, operation.id, input, confirmed);
      message[result.ok ? 'success' : 'error'](resultText(result));
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '网络连接器操作失败');
    } finally {
      setBusy('');
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

      {!loading && !connectors.length ? <Empty description="当前没有启用网络连接器插件" /> : null}
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {connectors.map((view) => {
          const connector = view.connector;
          const status = view.status;
          const mode = status?.connectivity?.mode;
          return (
            <Card
              key={`${connector.instanceId}:${connector.contributionId}`}
              size="small"
              title={<Space><ApiOutlined /><strong>{connector.name || connector.id}</strong>{connector.transport ? <Tag>{connector.transport}</Tag> : null}</Space>}
            >
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {connector.description ? <Typography.Text type="secondary">{connector.description}</Typography.Text> : null}
                <Space wrap>
                  <Tag icon={status?.running ? <CheckCircleOutlined /> : <DisconnectOutlined />} color={status?.running ? 'success' : 'default'}>
                    {status?.state || '状态未知'}
                  </Tag>
                  {mode ? <Tag icon={<SafetyCertificateOutlined />}>{CONNECTIVITY_LABELS[mode] || mode}</Tag> : null}
                  {status?.version ? <Tag>{status.version}</Tag> : null}
                  {status?.connectivity?.latencyMs ? <Typography.Text type="secondary">{status.connectivity.latencyMs} ms</Typography.Text> : null}
                </Space>
                {status?.connectivity?.evidence ? (
                  <InlineNote tone="info" description={`${status.connectivity.evidence.source || '未标注来源'} · ${status.connectivity.evidence.path || '路径未知'}`}>
                    连通性证据：{status.connectivity.evidence.transport || '传输方式未标注'}
                  </InlineNote>
                ) : null}
                {view.error ? <InlineNote tone="error">连接器状态读取失败：{view.error}</InlineNote> : null}
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
                {connector.operations.map((operation) => {
                  const inputKind = operationInputKind(operation, view);
                  if (inputKind === 'none') return null;
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
              </Space>
            </Card>
          );
        })}
      </Space>
    </section>
  );
}
