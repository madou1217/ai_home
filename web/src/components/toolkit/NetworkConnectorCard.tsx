import { Input, Popconfirm, Space, Tag, Typography } from 'antd';
import {
  ApiOutlined,
  DeleteOutlined,
  DownloadOutlined,
  LinkOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  SafetyCertificateOutlined,
  SettingOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { SettingRow, SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import type {
  NetworkConnectorConnectivityMode,
  NetworkConnectorInputKind,
  NetworkConnectorOperation,
  NetworkConnectorOperationResult,
  NetworkConnectorView
} from '@/types';
import './ToolkitPanels.css';

export const CONNECTIVITY_LABELS: Record<NetworkConnectorConnectivityMode, string> = {
  'direct-p2p': '直连 P2P',
  'peer-relay': '对等中继',
  'derp-relay': 'DERP/云中继',
  'outbound-tunnel': '出站隧道',
  'wireguard-tunnel': 'WireGuard 隧道',
  unavailable: '不可用',
  unknown: '已连接 · 路径未知'
};

const INPUT_OPERATIONS = new Set(['configure', 'connect', 'login', 'authenticate', 'auth']);
const CONFIRM_OPERATIONS = new Set(['install', 'uninstall', 'enable', 'disable', 'configure']);

export interface ConnectorConfigField {
  key: string;
  description?: string;
  secret: boolean;
  proxy: boolean;
}

export function connectorActionLabel(operation: NetworkConnectorOperation) {
  return operation.label || operation.id;
}

export function connectorRequiresConfirmation(operation: NetworkConnectorOperation) {
  if (CONFIRM_OPERATIONS.has(operation.id)) return true;
  return operation.confirmation === 'required';
}

export function connectorOperationInputKind(
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

export function connectorInputKey(view: NetworkConnectorView, operation: NetworkConnectorOperation) {
  return `${view.connector.contributionId}:${operation.id}`;
}

export function connectorConfigFields(view: NetworkConnectorView): ConnectorConfigField[] {
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

function operationIcon(id: string) {
  switch (id) {
    case 'install':
      return <DownloadOutlined />;
    case 'uninstall':
      return <DeleteOutlined />;
    case 'enable':
    case 'connect':
    case 'login':
    case 'authenticate':
    case 'auth':
      return <PlayCircleOutlined />;
    case 'disable':
      return <PauseCircleOutlined />;
    case 'configure':
      return <SettingOutlined />;
    default:
      return <ApiOutlined />;
  }
}

function resultText(result: NetworkConnectorOperationResult) {
  return result.ok ? (result.message || '操作已完成') : (result.message || '操作失败');
}

function resolveConnectionBadge(
  view: NetworkConnectorView,
  activeOperation: NetworkConnectorOperation | undefined,
  result: NetworkConnectorOperationResult | undefined
) {
  if (activeOperation) {
    return <SettingStatusTag status="saving" label="连接中" detail={`正在${connectorActionLabel(activeOperation)}`} compact />;
  }
  if (view.error || (result && !result.ok) || view.status?.connectivity?.mode === 'unavailable') {
    return <SettingStatusTag status="error" label="连接失败" detail={view.error || result?.message} compact />;
  }
  if (view.status?.running) {
    return <SettingStatusTag status="saved" label="已连接" detail={view.status.state} compact />;
  }
  if (!view.status) {
    return <SettingStatusTag status="unset" label="未设定" compact />;
  }
  return <SettingStatusTag status="unset" label="未连接" detail={view.status.state} compact />;
}

interface NetworkConnectorCardProps {
  view: NetworkConnectorView;
  busy: string;
  busyElapsedSeconds: number;
  proxyBusy: string;
  inputs: Record<string, string>;
  configValues: Record<string, string>;
  result?: NetworkConnectorOperationResult;
  onInputChange: (key: string, value: string) => void;
  onConfigValueChange: (connectorId: string, fieldKey: string, value: string) => void;
  onApplyAihProxy: (connectorId: string, fieldKey: string) => void;
  onOperate: (view: NetworkConnectorView, operation: NetworkConnectorOperation, confirmed?: boolean) => void;
  onOpenLink: (url: string) => void;
}

export default function NetworkConnectorCard({
  view,
  busy,
  busyElapsedSeconds,
  proxyBusy,
  inputs,
  configValues,
  result,
  onInputChange,
  onConfigValueChange,
  onApplyAihProxy,
  onOperate,
  onOpenLink
}: NetworkConnectorCardProps) {
  const connector = view.connector;
  const status = view.status;
  const mode = status?.connectivity?.mode;
  const fields = connectorConfigFields(view);
  const activeOperation = busy.startsWith(`${connector.contributionId}:`)
    ? connector.operations.find((item) => busy === connectorInputKey(view, item))
    : undefined;

  const customInputOps = connector.operations.filter((operation) => {
    const inputKind = connectorOperationInputKind(operation, view);
    if (inputKind === 'none') return false;
    if (operation.id === 'configure' && fields.length) return false;
    return true;
  });

  return (
    <div id={`connector-${connector.id}`} style={{ scrollMarginTop: 72 }}>
      <SettingSection
        title={connector.name || connector.id}
        description={connector.description}
        status={(
          <Space size={6} wrap>
            {resolveConnectionBadge(view, activeOperation, result)}
            {status ? (
              <SettingStatusTag
                status={status.installed ? 'saved' : 'unset'}
                label={status.installed ? '已安装' : '未安装'}
                compact
              />
            ) : null}
            {status?.installed ? (
              <SettingStatusTag
                status={status.enabled ? 'applied' : 'unset'}
                label={status.enabled ? '已启用' : '未启用'}
                compact
              />
            ) : null}
            {connector.transport ? <Tag>{connector.transport}</Tag> : null}
          </Space>
        )}
      >
        <SettingRow
          title="连接状态与操作"
          description={status?.message || '执行连接器安装、启停或接入操作。'}
          layout="stacked"
          control={(
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <div className="toolkit-connector-status-strip">
                {mode ? (
                  <Tag icon={<SafetyCertificateOutlined />}>
                    {CONNECTIVITY_LABELS[mode] || mode}
                  </Tag>
                ) : null}
                {status?.version ? <Tag>{status.version}</Tag> : null}
                {status?.autostart ? <Tag color="processing">开机自启</Tag> : null}
                {status?.connectivity?.latencyMs ? (
                  <span className="toolkit-connector-meta-text">{status.connectivity.latencyMs} ms</span>
                ) : null}
                {status?.state ? (
                  <span className="toolkit-connector-meta-text">状态：{status.state}</span>
                ) : null}
              </div>

              {status?.connectivity?.evidence ? (
                <InlineNote
                  tone="info"
                  description={`${status.connectivity.evidence.source || '未标注来源'} · ${status.connectivity.evidence.path || '路径未知'}`}
                >
                  连通性证据：{status.connectivity.evidence.transport || '传输方式未标注'}
                </InlineNote>
              ) : null}

              {view.error ? (
                <InlineNote tone="error">连接器状态读取失败：{view.error}</InlineNote>
              ) : null}

              {activeOperation ? (
                <InlineNote tone="info">
                  正在{connectorActionLabel(activeOperation)}（安装/卸载可能耗时数分钟），已用 {busyElapsedSeconds}s
                </InlineNote>
              ) : null}

              <Space wrap size={6}>
                {connector.operations.map((operation) => {
                  const key = connectorInputKey(view, operation);
                  const confirmed = connectorRequiresConfirmation(operation);
                  const danger = ['uninstall', 'disable'].includes(operation.id);
                  const button = (
                    <Button
                      key={operation.id}
                      size="small"
                      danger={danger}
                      icon={operationIcon(operation.id)}
                      loading={busy === key}
                      disabled={Boolean(busy) || operationDisabled(operation, status)}
                      onClick={confirmed ? undefined : () => onOperate(view, operation)}
                    >
                      {connectorActionLabel(operation)}
                    </Button>
                  );
                  return confirmed ? (
                    <Popconfirm
                      key={operation.id}
                      title={`确认${connectorActionLabel(operation)}？`}
                      description="该操作会修改或停用外部网络组件。"
                      okText="确认执行"
                      cancelText="取消"
                      okButtonProps={{ danger }}
                      onConfirm={() => onOperate(view, operation, true)}
                    >
                      {button}
                    </Popconfirm>
                  ) : button;
                })}
              </Space>

              {result ? (
                <div>
                  <InlineNote tone={result.ok ? 'success' : 'error'}>
                    {resultText(result)}
                  </InlineNote>
                  {result.links?.length ? (
                    <Space wrap style={{ marginTop: 8 }}>
                      {result.links.map((link) => (
                        <Button
                          key={`${connector.id}:result-link:${link.label}`}
                          size="small"
                          icon={<LinkOutlined />}
                          onClick={() => onOpenLink(link.url)}
                        >
                          {link.label}
                        </Button>
                      ))}
                    </Space>
                  ) : null}
                  {result.output?.length ? (
                    <details style={{ marginTop: 8 }}>
                      <summary style={{ cursor: 'pointer' }}>操作日志（{result.output.length} 行）</summary>
                      <pre className="toolkit-connector-log">{result.output.join('\n')}</pre>
                    </details>
                  ) : null}
                </div>
              ) : null}
            </Space>
          )}
        />

        {fields.length ? (
          <SettingRow
            title="连接器参数"
            description="敏感字段仅提交给插件，不在状态列表回显。"
            layout="stacked"
            control={(
              <div className="toolkit-connector-field-grid">
                {fields.map((field) => (
                  <div className="toolkit-connector-field" key={field.key}>
                    <div className="toolkit-connector-field-label">
                      <span className="toolkit-connector-field-name">{field.key}</span>
                      {field.proxy ? (
                        <Button
                          size="small"
                          loading={proxyBusy === `${connector.id}:${field.key}`}
                          disabled={Boolean(proxyBusy)}
                          onClick={() => onApplyAihProxy(connector.id, field.key)}
                        >
                          填入本机代理
                        </Button>
                      ) : null}
                    </div>
                    {field.description ? (
                      <span className="toolkit-connector-field-desc">{field.description}</span>
                    ) : null}
                    {field.secret ? (
                      <Input.Password
                        placeholder="输入敏感值"
                        value={configValues[field.key] || ''}
                        onChange={(event) => onConfigValueChange(connector.id, field.key, event.target.value)}
                      />
                    ) : (
                      <Input
                        value={configValues[field.key] || ''}
                        onChange={(event) => onConfigValueChange(connector.id, field.key, event.target.value)}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          />
        ) : null}

        {customInputOps.length ? (
          <SettingRow
            title="操作附加输入"
            description="仅在点击对应操作时发送，不写入状态列表。"
            layout="stacked"
            control={(
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {customInputOps.map((operation) => {
                  const inputKind = connectorOperationInputKind(operation, view);
                  const key = connectorInputKey(view, operation);
                  return (
                    <div className="toolkit-connector-field" key={`${key}:input`}>
                      <span className="toolkit-connector-field-name">{connectorActionLabel(operation)}</span>
                      {inputKind === 'secret' ? (
                        <Input.Password
                          placeholder="输入敏感值"
                          value={inputs[key] || ''}
                          onChange={(event) => onInputChange(key, event.target.value)}
                        />
                      ) : (
                        <Input.TextArea
                          autoSize={{ minRows: 2, maxRows: 5 }}
                          placeholder="输入 JSON 或插件自定义内容"
                          value={inputs[key] || ''}
                          onChange={(event) => onInputChange(key, event.target.value)}
                        />
                      )}
                    </div>
                  );
                })}
              </Space>
            )}
          />
        ) : null}

        {connector.setup ? (
          <SettingRow
            title="接入步骤"
            description={connector.setup.summary}
            layout="stacked"
            control={(
              <div className="toolkit-connector-subbox">
                {connector.setup.steps?.length ? (
                  <ol className="toolkit-connector-steps">
                    {connector.setup.steps.map((step, index) => (
                      <li key={`${connector.id}:step:${index}`}>
                        <Typography.Text>{step}</Typography.Text>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {connector.setup.links?.length ? (
                  <Space wrap style={{ marginTop: 8 }}>
                    {connector.setup.links.map((link) => (
                      <Button
                        key={`${connector.id}:link:${link.label}`}
                        size="small"
                        icon={<LinkOutlined />}
                        onClick={() => onOpenLink(link.url)}
                      >
                        {link.label}
                      </Button>
                    ))}
                  </Space>
                ) : null}
              </div>
            )}
          />
        ) : null}
      </SettingSection>
    </div>
  );
}
