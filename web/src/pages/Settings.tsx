import { useState, useEffect, useRef } from 'react';
import type { ComponentProps } from 'react';
import type { FormInstance } from 'antd';
import { Form, InputNumber, Button, Input, message, Space, Switch, Alert, Tabs, Select, Tag, Popconfirm, QRCode } from 'antd';
import { CopyOutlined, DeleteOutlined, FileTextOutlined, LinkOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, SearchOutlined } from '@ant-design/icons';
import { configAPI, controlPlaneDevicesAPI, managementAPI, remoteNodesAPI } from '@/services/api';
import {
  fetchControlPlaneDescriptor,
  isControlPlaneProfileRefreshable,
  listControlPlaneProfiles,
  normalizeControlPlaneEndpoint,
  parseControlPlanePairIntentFromSearch,
  pairControlPlaneDevice,
  removeControlPlaneProfile,
  refreshControlPlaneProfileStates,
  refreshControlPlaneDeviceState,
  saveControlPlaneProfile,
  summarizeControlPlaneClientReadiness,
  summarizeControlPlaneProfileNodes,
  summarizeControlPlaneProfiles
} from '@/services/control-plane-profiles';
import {
  formatEndpointHintLabel,
  getBrowserControlEndpoint as getDefaultControlEndpoint,
  isLoopbackEndpoint,
  normalizeEndpointHintWarnings,
  resolveDefaultControlEndpoint
} from '@/services/control-plane-endpoints';
import {
  getActiveControlPlaneProfileId,
  resolveStoredActiveControlPlaneProfile,
  selectActiveControlPlaneProfile,
  syncStoredActiveControlPlaneProfile
} from '@/services/control-plane-selection';
import { resolveCurrentDeviceIdentity } from '@/services/device-identity';
import type {
  UsageConfig,
  ServerConfig,
  ManagementRestartEvent,
  ControlPlaneDevice,
  ControlPlaneDeviceInvite,
  ControlPlaneDeviceInviteCreatePayload,
  ControlPlaneDeviceInviteCreateResponse,
  ControlPlaneEndpointHint,
  ControlPlaneProfile,
  ControlPlaneProfileState,
  RemoteNode,
  RemoteNodeBootstrapApplyPayload,
  RemoteNodeBootstrapApplyAction,
  RemoteNodeBootstrapManualCommand,
  RemoteNodeBootstrapPlanResponse,
  RemoteNodeBootstrapProbeExecutionStep,
  RemoteNodeBootstrapProbeResponse,
  RemoteNodeBootstrapProbeResult,
  RemoteNodeBootstrapReadinessCheck,
  RemoteNodeBootstrapTarget,
  RemoteNodeDefaults,
  RemoteNodeInvite,
  RemoteNodeInviteCreatePayload,
  RemoteNodeInviteCreateResponse,
  RemoteNodeSavePayload,
  RemoteNodeTransportCatalog,
  RemoteNodeTransportDefaults,
  RemoteNodeTransportKind,
  RemoteNodeTransportRouteRole,
  RemoteNodeTransportStrategy,
  RemoteNodeTransportTrustLevel
} from '@/types';
import PageHero from '@/components/ui/PageHero';
import ModelAliases from './ModelAliases';
import SshHostsPanel from './SshHostsPanel';
import { buildRemoteNodeDefaultPreview } from './settings-remote-node-view.js';
import './Settings.css';

const DEFAULT_INVITE_CAPABILITIES = ['status', 'metrics', 'accounts', 'models', 'usage'];
const DEFAULT_REMOTE_TRANSPORT_KIND: RemoteNodeTransportKind = 'relay';
const DEFAULT_DEVICE_SCOPES = ['control-plane:read', 'nodes:read', 'status:read', 'accounts:read', 'usage:read', 'sessions:read', 'sessions:write'];
const DEVICE_PROFILE_SYNC_SCOPES = ['control-plane:read', 'nodes:read', 'status:read', 'accounts:read', 'sessions:read'];
const MOBILE_DEVICE_PLATFORMS = new Set(['ios', 'android']);

const DEVICE_SCOPE_OPTIONS = [
  { value: 'control-plane:read', label: 'Control Plane' },
  { value: 'nodes:read', label: 'Nodes' },
  { value: 'status:read', label: 'Status' },
  { value: 'accounts:read', label: 'Accounts' },
  { value: 'usage:read', label: 'Usage' },
  { value: 'sessions:read', label: 'Sessions Read' },
  { value: 'sessions:write', label: 'Sessions Write' }
];

type NumericAddonInputProps = ComponentProps<typeof InputNumber> & {
  addonAfter: React.ReactNode;
};

const NumericAddonInput = ({ addonAfter, style, ...props }: NumericAddonInputProps) => (
  <InputNumber {...props} addonAfter={addonAfter} style={{ width: '100%', ...style }} />
);

const REMOTE_TRANSPORT_KIND_OPTIONS = [
  { value: 'direct', label: 'Direct' },
  { value: 'frp', label: 'FRP' },
  { value: 'ssh', label: 'SSH Tunnel' },
  { value: 'tailscale', label: 'Tailscale' },
  { value: 'zerotier', label: 'ZeroTier' },
  { value: 'wireguard', label: 'WireGuard' },
  { value: 'omr', label: 'OpenMPTCPRouter' },
  { value: 'mptcp', label: 'MPTCP' },
  { value: 'relay', label: 'AIH Relay' }
];

const REMOTE_TRANSPORT_ROUTE_ROLE_OPTIONS = [
  { value: 'data-plane', label: 'Data Plane' },
  { value: 'bootstrap', label: 'Bootstrap' },
  { value: 'underlay', label: 'Underlay' }
];

const REMOTE_TRANSPORT_TRUST_LEVEL_OPTIONS = [
  { value: 'manual', label: 'Manual' },
  { value: 'external', label: 'External' },
  { value: 'verified', label: 'Verified' },
  { value: 'managed', label: 'Managed' }
];

const REMOTE_BOOTSTRAP_TARGET_OPTIONS: Array<{ value: RemoteNodeBootstrapTarget; label: string }> = [
  { value: 'linux', label: 'Linux' },
  { value: 'darwin', label: 'macOS' },
  { value: 'win32', label: 'Windows' }
];

type RemoteTransportFormDefaults = {
  transportKind: RemoteNodeTransportKind;
  provider: string;
  routeRole: RemoteNodeTransportRouteRole;
  trustLevel: RemoteNodeTransportTrustLevel;
};

type InviteWatchedValues = {
  transportKind?: RemoteNodeTransportKind;
  controlEndpoint?: string;
  repoUrl?: string;
  endpointHint?: string;
};

type RemoteNodeInviteFormValues = Partial<RemoteNodeInviteCreatePayload> & {
  expiresMinutes?: number;
};

type RemoteNodeServiceIssue = {
  severity?: string;
  code?: string;
  message?: string;
};

type RemoteNodeServiceAction = {
  label?: string;
  command?: string;
};

type RemoteNodeServiceDiagnostics = {
  state?: string;
  running?: boolean;
  issues?: RemoteNodeServiceIssue[];
  nextActions?: RemoteNodeServiceAction[];
};

type RemoteNodeDiagnostics = {
  service?: RemoteNodeServiceDiagnostics;
};

type RemoteNodeTestView = {
  ok: boolean;
  checkedAt: number;
  service?: RemoteNodeServiceDiagnostics;
  message?: string;
};

const resolveRemoteTransportKind = (value?: RemoteNodeTransportKind): RemoteNodeTransportKind => {
  return REMOTE_TRANSPORT_KIND_OPTIONS.some((option) => option.value === value)
    ? value as RemoteNodeTransportKind
    : DEFAULT_REMOTE_TRANSPORT_KIND;
};

const buildRemoteTransportFormDefaults = (
  policy?: RemoteNodeTransportDefaults,
  kind?: RemoteNodeTransportKind
): RemoteTransportFormDefaults => {
  const transportKind = resolveRemoteTransportKind(kind);
  const defaults = policy?.[transportKind];
  return {
    transportKind,
    provider: defaults?.provider || transportKind,
    routeRole: defaults?.routeRole || 'data-plane',
    trustLevel: defaults?.trustLevel || 'manual'
  };
};

const applyRemoteTransportFormDefaults = (
  form: FormInstance,
  policy?: RemoteNodeTransportDefaults,
  kind?: RemoteNodeTransportKind
) => {
  form.setFieldsValue(buildRemoteTransportFormDefaults(policy, kind));
};

const pickInviteWatchedValues = (
  values: RemoteNodeInviteFormValues
): InviteWatchedValues => ({
  ...(Object.prototype.hasOwnProperty.call(values, 'transportKind')
    ? { transportKind: values.transportKind }
    : {}),
  ...(Object.prototype.hasOwnProperty.call(values, 'controlEndpoint')
    ? { controlEndpoint: values.controlEndpoint }
    : {}),
  ...(Object.prototype.hasOwnProperty.call(values, 'repoUrl')
    ? { repoUrl: values.repoUrl }
    : {}),
  ...(Object.prototype.hasOwnProperty.call(values, 'endpointHint')
    ? { endpointHint: values.endpointHint }
    : {})
});

const getRemoteTransportCatalogEntry = (
  catalog: RemoteNodeTransportCatalog | undefined,
  kind?: RemoteNodeTransportKind
) => {
  const transportKind = resolveRemoteTransportKind(kind);
  return catalog?.[transportKind] || null;
};

const getRemoteTransportEndpointMode = (
  catalog: RemoteNodeTransportCatalog | undefined,
  kind?: RemoteNodeTransportKind
) => (
  getRemoteTransportCatalogEntry(catalog, kind)?.endpointMode
    || (resolveRemoteTransportKind(kind) === 'relay' ? 'relay' : 'http')
);

const isRemoteTransportEndpointRequired = (
  catalog: RemoteNodeTransportCatalog | undefined,
  kind?: RemoteNodeTransportKind
) => getRemoteTransportEndpointMode(catalog, kind) === 'http';

const getRemoteTransportEndpointHelp = (
  catalog: RemoteNodeTransportCatalog | undefined,
  kind?: RemoteNodeTransportKind
) => {
  const mode = getRemoteTransportEndpointMode(catalog, kind);
  if (mode === 'relay') return 'AIH Relay 会自动使用 relay://<nodeId>，无公网机器不需要填写入口。';
  if (mode === 'none') return '该 transport 不需要管理入口。';
  return '可以是公网 HTTPS、FRP/SSH 本地转发、Tailscale/ZeroTier/WireGuard/OMR 地址。';
};

const getRemoteTransportEndpointPlaceholder = (
  catalog: RemoteNodeTransportCatalog | undefined,
  kind?: RemoteNodeTransportKind
) => {
  const mode = getRemoteTransportEndpointMode(catalog, kind);
  if (mode === 'relay') return 'AIH Relay 自动生成';
  if (mode === 'none') return '无需填写';
  return 'https://node.example.com 或 http://127.0.0.1:19527';
};

const formatTransportKinds = (items: RemoteNodeTransportKind[]) => (
  items.length ? items.join(' / ') : 'none'
);

const normalizeRemoteNodeDefaults = (defaults?: RemoteNodeDefaults | null): RemoteNodeDefaults => {
  const policy = { ...(defaults?.transportDefaults || {}) };
  const transportDefaults = buildRemoteTransportFormDefaults(policy, defaults?.transportKind);
  policy[transportDefaults.transportKind] = {
    provider: defaults?.provider || transportDefaults.provider,
    routeRole: defaults?.routeRole || transportDefaults.routeRole,
    trustLevel: defaults?.trustLevel || transportDefaults.trustLevel
  };
  return {
    nodeId: defaults?.nodeId || '',
    name: defaults?.name || '',
    ...transportDefaults,
    provider: defaults?.provider || transportDefaults.provider,
    routeRole: defaults?.routeRole || transportDefaults.routeRole,
    trustLevel: defaults?.trustLevel || transportDefaults.trustLevel,
    transportDefaults: policy,
    transportCatalog: defaults?.transportCatalog || {},
    transportStrategies: Array.isArray(defaults?.transportStrategies) ? defaults.transportStrategies : [],
    preferredTransports: defaults?.preferredTransports?.length ? defaults.preferredTransports : [transportDefaults.transportKind],
    capabilities: defaults?.capabilities?.length ? defaults.capabilities : DEFAULT_INVITE_CAPABILITIES,
    repoUrl: defaults?.repoUrl || '',
    repoSubdir: defaults?.repoSubdir || '',
    repoDir: defaults?.repoDir || ''
  };
};

const parseProbeTargets = (value?: string[] | string) => {
  const source = Array.isArray(value) ? value.join('\n') : String(value || '');
  return Array.from(new Set(source
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)));
};

const normalizeInteger = (value: unknown, fallback: number, min: number, max: number) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
};

const uniqueTextList = (values: Array<string | undefined | null> = []) => {
  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean)));
};

const readSettledValue = <T, F>(result: PromiseSettledResult<T>, fallback: F): T | F => (
  result.status === 'fulfilled' ? result.value : fallback
);

const renderWarningAlert = (warnings: string[], messageText: string) => {
  const items = uniqueTextList(warnings);
  if (items.length === 0) return null;
  return (
    <Alert
      type="warning"
      showIcon
      message={messageText}
      description={(
        <ul className="settings-warning-list">
          {items.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
    />
  );
};

const BOOTSTRAP_APPLY_INPUT_LABELS: Record<string, string> = {
  'control-url': 'Control Endpoint',
  'invite-url': '加入命令',
  'repo-url': 'Repo URL',
  endpoint: 'Endpoint Hint'
};

const formatBootstrapApplyMissingInputs = (missingInputs: string[]) => (
  uniqueTextList(missingInputs)
    .map((item) => BOOTSTRAP_APPLY_INPUT_LABELS[item] || item)
    .join('、')
);

const resolveBootstrapApplyMissingInputs = (
  values: Partial<RemoteNodeInviteCreatePayload> & { endpoint?: string },
  latestJoinUrl: string
) => {
  const source = values || {};
  const missingInputs: string[] = [];
  const transportKind = resolveRemoteTransportKind(source.transportKind);
  if (!String(source.controlEndpoint || '').trim()) missingInputs.push('control-url');
  if (!String(latestJoinUrl || source.inviteUrl || '').trim()) missingInputs.push('invite-url');
  if (!String(source.repoUrl || '').trim()) missingInputs.push('repo-url');
  if (transportKind !== 'relay' && !String(source.endpoint || source.endpointHint || '').trim()) {
    missingInputs.push('endpoint');
  }
  return uniqueTextList(missingInputs);
};

const resolveDeviceInviteName = (deviceIdentity: ReturnType<typeof resolveCurrentDeviceIdentity>) => (
  MOBILE_DEVICE_PLATFORMS.has(deviceIdentity.platform) ? deviceIdentity.name : '手机/PWA'
);

const quoteCliArg = (value: string) => `"${String(value || '').replace(/(["\\$`])/g, '\\$1')}"`;

const buildJoinCommand = (joinUrl: string) => {
  const url = String(joinUrl || '').trim();
  return url ? `aih node join ${quoteCliArg(url)}` : '';
};

const resolveInviteJoinCommand = (invite: RemoteNodeInviteCreateResponse | null) => {
  const command = String(invite?.joinCommand || '').trim();
  return command || buildJoinCommand(invite?.joinUrl || '');
};

const renderControlEndpointHints = (
  hints: ControlPlaneEndpointHint[],
  warnings: string[],
  onSelect: (endpoint: string) => void
) => {
  if (hints.length === 0) return null;
  return (
    <div className="settings-endpoint-hints">
      <Space size={[6, 6]} wrap>
        {hints.map((hint) => (
          <Button
            key={`${hint.source}:${hint.endpoint}`}
            size="small"
            type={hint.recommended ? 'primary' : 'default'}
            icon={<LinkOutlined />}
            htmlType="button"
            onClick={() => onSelect(hint.endpoint)}
          >
            {formatEndpointHintLabel(hint)}
          </Button>
        ))}
      </Space>
      {warnings.length > 0 && (
        <div className="settings-endpoint-warning">
          {warnings.slice(0, 2).map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      )}
    </div>
  );
};

const PROBE_COMMAND_NAMES = ['node', 'npm', 'git', 'aih'] as const;

const formatProbePorts = (result: RemoteNodeBootstrapProbeResult, open: boolean) => {
  if (result.kind !== 'tcp') return '';
  const ports = result.ports.filter((item) => item.open === open).map((item) => item.port);
  return ports.length ? ports.join(', ') : 'none';
};

const formatProbeCommands = (result: RemoteNodeBootstrapProbeResult) => {
  if (result.kind !== 'ssh') return '';
  return PROBE_COMMAND_NAMES
    .map((name) => `${name}:${result.commands?.[name] ? 'ok' : 'missing'}`)
    .join(', ');
};

const getProbeStatus = (result: RemoteNodeBootstrapProbeResult) => {
  if (result.kind === 'ssh') {
    if (result.status === 'auth-required') return { color: 'gold', label: 'SSH 需认证' };
    return result.status === 'reachable'
      ? { color: 'green', label: 'SSH 可达' }
      : { color: 'red', label: 'SSH 不可达' };
  }
  if (result.accessMode === 'local-manual') return { color: 'gold', label: '手动执行' };
  if (result.accessMode === 'winrm') return { color: 'blue', label: 'WinRM' };
  if (result.accessMode === 'ssh') return { color: 'green', label: 'SSH Port' };
  return { color: 'red', label: '不可达' };
};

const getProbeResultTitle = (result: RemoteNodeBootstrapProbeResult) => (
  result.kind === 'ssh' ? `ssh ${result.target}` : `tcp ${result.target}`
);

const getProbeResultMeta = (result: RemoteNodeBootstrapProbeResult) => {
  if (result.kind === 'ssh') {
    if (result.status === 'auth-required') return ['需要交互认证'];
    const os = [result.platform || 'unknown', result.arch || ''].filter(Boolean).join(' ');
    return [os, formatProbeCommands(result)].filter(Boolean);
  }
  return [
    `open: ${formatProbePorts(result, true)}`,
    `closed: ${formatProbePorts(result, false)}`
  ];
};

const formatBootstrapScriptTitle = (type?: string) => (
  type === 'powershell' ? 'Bootstrap 脚本 · PowerShell' : 'Bootstrap 脚本 · Shell'
);

const getProbeCopyActions = (result: RemoteNodeBootstrapProbeResult) => {
  const actions: Array<{ key: string; label: string; value: string; successMessage: string }> = [];
  const action = result.bootstrapAction;
  if (action?.remoteRunCommand) {
    actions.push({
      key: 'remote-run',
      label: '复制 SSH 执行',
      value: action.remoteRunCommand,
      successMessage: '已复制 SSH 执行命令'
    });
  }
  if (action?.targetCommand) {
    const isWindowsTarget = result.bootstrapTarget === 'win32';
    actions.push({
      key: 'target-command',
      label: isWindowsTarget ? '复制 PowerShell 执行' : '复制目标执行',
      value: action.targetCommand,
      successMessage: isWindowsTarget ? '已复制 PowerShell 执行命令' : '已复制目标执行命令'
    });
  }
  if (Array.isArray(action?.manualCommands)) {
    action.manualCommands.forEach((item) => {
      if (!item?.command) return;
      actions.push({
        key: item.key || item.label || item.command,
        label: item.label || '复制手动命令',
        value: item.command,
        successMessage: `已复制 ${item.label || '手动命令'}`
      });
    });
  }
  if (result.bootstrapScript?.content) {
    actions.push({
      key: 'script',
      label: '复制脚本',
      value: result.bootstrapScript.content,
      successMessage: '已复制 Bootstrap 脚本'
    });
  }
  if (action?.generateScriptCommand && !action.remoteRunCommand) {
    actions.push({
      key: 'generate-script',
      label: '复制生成命令',
      value: action.generateScriptCommand,
      successMessage: '已复制脚本生成命令'
    });
  }
  return actions;
};

const getProbeExecutionStatusMeta = (step: RemoteNodeBootstrapProbeExecutionStep) => {
  if (step.status === 'ready') return { color: 'green', label: '可直接执行' };
  if (step.status === 'manual') return { color: 'gold', label: '需人工执行' };
  if (step.status === 'needs-input') return { color: 'blue', label: '需补目标' };
  return { color: 'red', label: '不可用' };
};

const getProbeExecutionCopyAction = (step: RemoteNodeBootstrapProbeExecutionStep) => {
  if (!step.command) return null;
  if (step.channel === 'ssh') return { label: '复制 SSH 执行', successMessage: '已复制 SSH 执行命令' };
  if (step.channel === 'winrm' || step.channel === 'local-manual') {
    return { label: '复制生成命令', successMessage: '已复制脚本生成命令' };
  }
  return { label: '复制命令', successMessage: '已复制命令' };
};

const normalizeBootstrapManualCommands = (items?: RemoteNodeBootstrapManualCommand[]) => (
  (Array.isArray(items) ? items : [])
    .map((item) => ({
      key: String(item?.key || item?.label || item?.command || '').trim(),
      label: String(item?.label || '复制手动命令').trim(),
      command: String(item?.command || '').trim(),
      note: String(item?.note || '').trim()
    }))
    .filter((item) => item.command)
);

const getBootstrapApplyStateMeta = (action: RemoteNodeBootstrapApplyAction) => {
  if (action.executionState === 'dry-run') return { color: 'green', label: 'SSH dry-run' };
  if (action.executionState === 'manual') return { color: 'gold', label: '需人工' };
  if (action.executionState === 'needs-input') return { color: 'blue', label: '需补目标' };
  if (action.executionState === 'blocked') return { color: 'red', label: '阻塞' };
  if (action.executionState === 'executed') return { color: 'green', label: '已执行' };
  if (action.executionState === 'failed') return { color: 'red', label: '失败' };
  return { color: 'default', label: action.executionState || '未知' };
};

const getBootstrapReadinessMeta = (check: RemoteNodeBootstrapReadinessCheck) => {
  if (check.status === 'provided') return { color: 'green', label: '已提供' };
  if (check.status === 'checked-by-script') return { color: 'green', label: '脚本检查' };
  if (check.status === 'planned') return { color: 'green', label: '计划安装' };
  if (check.status === 'target-derived') return { color: 'blue', label: '目标机派生' };
  if (check.status === 'placeholder') return { color: 'gold', label: '待补输入' };
  if (check.status === 'disabled') return { color: 'default', label: '已关闭' };
  return { color: 'default', label: check.status || 'unknown' };
};

const formatInviteStatus = (invite: RemoteNodeInvite) => {
  if (invite.consumedAt) return { color: 'green', label: '已使用' };
  if (invite.expiresAt && invite.expiresAt < Date.now()) return { color: 'red', label: '已过期' };
  return { color: 'blue', label: '可用' };
};

const formatDeviceInviteStatus = (invite: ControlPlaneDeviceInvite) => {
  if (invite.consumedAt) return { color: 'green', label: '已配对' };
  if (invite.expiresAt && invite.expiresAt < Date.now()) return { color: 'red', label: '已过期' };
  return { color: 'blue', label: '待配对' };
};

const formatTimestamp = (value: number) => {
  const timestamp = Number(value || 0);
  return timestamp > 0 ? new Date(timestamp).toLocaleString() : '从未';
};

const getRemoteNodeConnectionMeta = (node: RemoteNode) => {
  const connection = node.connection;
  if (connection?.status === 'online') {
    return {
      color: 'green',
      label: '在线',
      detail: connection.lastSeenAt ? `心跳 ${formatTimestamp(connection.lastSeenAt)}` : 'Relay 已连接'
    };
  }
  if (connection?.status === 'offline') {
    return {
      color: 'red',
      label: 'Relay 离线',
      detail: '等待节点主动连接'
    };
  }
  return {
    color: 'default',
    label: '未观测',
    detail: node.lastSeenAt ? `最近 ${formatTimestamp(node.lastSeenAt)}` : '未建立 Relay 会话'
  };
};

const getRemoteTransportStatusColor = (status: string) => {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'up') return 'green';
  if (normalized === 'degraded' || normalized === 'down') return 'red';
  return 'default';
};

const getRelayServiceStateMeta = (state?: string, running?: boolean) => {
  const normalized = String(state || '').toLowerCase();
  if (running || normalized === 'running') return { color: 'green', label: 'Service running' };
  if (normalized === 'installed') return { color: 'gold', label: 'Service installed' };
  if (normalized === 'missing') return { color: 'red', label: 'Service missing' };
  if (normalized === 'unsupported') return { color: 'default', label: 'Service unsupported' };
  return { color: 'default', label: 'Service unknown' };
};

const getRemoteNodeDiagnostics = (payload: unknown): RemoteNodeDiagnostics | null => {
  const source = payload && typeof payload === 'object'
    ? payload as { nodeDiagnostics?: RemoteNodeDiagnostics }
    : {};
  return source.nodeDiagnostics && typeof source.nodeDiagnostics === 'object'
    ? source.nodeDiagnostics
    : null;
};

const CONTROL_PLANE_PROFILE_STATUS: Record<ControlPlaneProfileState, { color: string; label: string }> = {
  draft: { color: 'default', label: '草稿' },
  discovered: { color: 'blue', label: '已发现' },
  pairing: { color: 'processing', label: '配对中' },
  paired: { color: 'green', label: '已配对' },
  degraded: { color: 'orange', label: '连接异常' },
  revoked: { color: 'red', label: '已撤销' },
  recovery: { color: 'gold', label: '恢复中' }
};

const getControlPlaneProfileStatus = (state: ControlPlaneProfileState) => (
  CONTROL_PLANE_PROFILE_STATUS[state] || CONTROL_PLANE_PROFILE_STATUS.draft
);

const CONTROL_PLANE_CLIENT_READINESS_STATUS = {
  ready: { color: 'green', label: '就绪' },
  attention: { color: 'gold', label: '待完善' },
  blocked: { color: 'red', label: '阻塞' }
} as const;

const getControlPlaneClientReadinessStatus = (status: keyof typeof CONTROL_PLANE_CLIENT_READINESS_STATUS) => (
  CONTROL_PLANE_CLIENT_READINESS_STATUS[status] || CONTROL_PLANE_CLIENT_READINESS_STATUS.attention
);

const getCurrentSearch = () => {
  return typeof window === 'undefined' ? '' : window.location.search;
};

  const getInitialSettingsTab = () => {
    if (typeof window === 'undefined') return 'basic';
    const params = new URLSearchParams(window.location.search);
    const tab = String(params.get('tab') || '').trim();
    if (tab === 'remote-nodes') return 'nodes';
    if (tab === 'control-planes' || tab === 'nodes' || tab === 'aliases') return tab;
    return parseControlPlanePairIntentFromSearch(window.location.search).pairUrlOrCode ? 'control-planes' : 'basic';
  };

const resolveHealthyProfileState = (profile: ControlPlaneProfile): ControlPlaneProfileState => {
  if (profile.state === 'pairing' || profile.state === 'recovery' || profile.state === 'revoked') {
    return profile.state;
  }
  return profile.authState === 'paired' ? 'paired' : 'discovered';
};

const resolveFailedProfileState = (profile: ControlPlaneProfile): ControlPlaneProfileState => {
  return profile.state === 'revoked' ? 'revoked' : 'degraded';
};

const formatActiveControlPlaneLabel = (profile: ControlPlaneProfile | null) => {
  if (!profile) return '未选择服务器';
  return profile.name || profile.endpoint || profile.id;
};

const formatActiveControlPlaneEndpoint = (profile: ControlPlaneProfile | null) => {
  if (!profile) return '请先配对或添加 Control Plane';
  return profile.endpoint;
};

const getInitialControlPlaneProfiles = () => listControlPlaneProfiles();

const getInitialActiveControlPlaneId = () => (
  resolveStoredActiveControlPlaneProfile(listControlPlaneProfiles(), getActiveControlPlaneProfileId()).profileId
);

const Settings = () => {
  const [usageForm] = Form.useForm();
  const [serverForm] = Form.useForm();
  const [controlPlaneForm] = Form.useForm();
  const [pairControlPlaneForm] = Form.useForm();
  const [deviceInviteForm] = Form.useForm();
  const [nodeForm] = Form.useForm();
  const [inviteForm] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverSaving, setServerSaving] = useState(false);
  const [controlPlaneSaving, setControlPlaneSaving] = useState(false);
  const [controlPlanePairing, setControlPlanePairing] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [deviceInviteCreating, setDeviceInviteCreating] = useState(false);
  const [checkingControlPlaneId, setCheckingControlPlaneId] = useState('');
  const [nodeSaving, setNodeSaving] = useState(false);
  const [inviteCreating, setInviteCreating] = useState(false);
  const [bootstrapPlanLoading, setBootstrapPlanLoading] = useState(false);
  const [bootstrapProbeRunning, setBootstrapProbeRunning] = useState(false);
  const [testingNodeId, setTestingNodeId] = useState('');
  const [revokingDeviceId, setRevokingDeviceId] = useState('');
  const [controlPlaneDevices, setControlPlaneDevices] = useState<ControlPlaneDevice[]>([]);
  const [controlPlaneDeviceInvites, setControlPlaneDeviceInvites] = useState<ControlPlaneDeviceInvite[]>([]);
  const [controlPlaneProfiles, setControlPlaneProfiles] = useState<ControlPlaneProfile[]>(getInitialControlPlaneProfiles);
  const [refreshingControlPlanes, setRefreshingControlPlanes] = useState(false);
  const [activeControlPlaneId, setActiveControlPlaneId] = useState(getInitialActiveControlPlaneId);
  const [remoteNodes, setRemoteNodes] = useState<RemoteNode[]>([]);
  const [remoteInvites, setRemoteInvites] = useState<RemoteNodeInvite[]>([]);
  const [remoteNodeDefaults, setRemoteNodeDefaults] = useState<RemoteNodeDefaults | null>(null);
  const [remoteNodeTestResults, setRemoteNodeTestResults] = useState<Record<string, RemoteNodeTestView>>({});
  const [controlPlaneEndpointHints, setControlPlaneEndpointHints] = useState<ControlPlaneEndpointHint[]>([]);
  const [controlPlaneEndpointWarnings, setControlPlaneEndpointWarnings] = useState<string[]>([]);
  const [latestInvite, setLatestInvite] = useState<RemoteNodeInviteCreateResponse | null>(null);
  const [latestBootstrapPlan, setLatestBootstrapPlan] = useState<RemoteNodeBootstrapPlanResponse | null>(null);
  const [latestBootstrapProbe, setLatestBootstrapProbe] = useState<RemoteNodeBootstrapProbeResponse | null>(null);
  const [bootstrapApplyRunning, setBootstrapApplyRunning] = useState(false);
  const [latestDeviceInvite, setLatestDeviceInvite] = useState<ControlPlaneDeviceInviteCreateResponse | null>(null);
  const [nodeTransportKind, setNodeTransportKind] = useState<RemoteNodeTransportKind>(DEFAULT_REMOTE_TRANSPORT_KIND);
  const [inviteWatchedValues, setInviteWatchedValues] = useState<InviteWatchedValues>({
    transportKind: DEFAULT_REMOTE_TRANSPORT_KIND,
    controlEndpoint: getDefaultControlEndpoint(),
    repoUrl: '',
    endpointHint: ''
  });
  const [restarting, setRestarting] = useState(false);
  const [restartEvent, setRestartEvent] = useState<ManagementRestartEvent | null>(null);
  const restartFallbackTimerRef = useRef<number | null>(null);
  const pairIntentAppliedRef = useRef(false);
  const inviteTransportKind = inviteWatchedValues.transportKind;
  const inviteControlEndpoint = inviteWatchedValues.controlEndpoint;
  const inviteRepoUrl = inviteWatchedValues.repoUrl;
  const inviteEndpointHint = inviteWatchedValues.endpointHint;
  const remoteTransportDefaults = remoteNodeDefaults?.transportDefaults;
  const remoteTransportCatalog = remoteNodeDefaults?.transportCatalog;
  const getRemoteTransportFormDefaults = (kind?: RemoteNodeTransportKind) => (
    buildRemoteTransportFormDefaults(remoteTransportDefaults, kind)
  );
  const setInviteFieldsValue = (values: RemoteNodeInviteFormValues) => {
    inviteForm.setFieldsValue(values);
    setInviteWatchedValues((current) => ({
      ...current,
      ...pickInviteWatchedValues(values)
    }));
  };
  const setNodeFieldsValue = (values: Partial<RemoteNodeSavePayload>) => {
    nodeForm.setFieldsValue(values);
    if (Object.prototype.hasOwnProperty.call(values, 'transportKind')) {
      setNodeTransportKind(resolveRemoteTransportKind(values.transportKind));
    }
  };
  const renderRemoteTransportSummary = (kind?: RemoteNodeTransportKind) => {
    const defaults = getRemoteTransportFormDefaults(kind);
    const entry = getRemoteTransportCatalogEntry(remoteTransportCatalog, defaults.transportKind);
    return (
      <div className="settings-transport-summary">
        <div className="settings-transport-summary-tags">
          <Tag>{defaults.provider}</Tag>
          <Tag>{entry?.lane || defaults.routeRole}</Tag>
          <Tag>{defaults.trustLevel}</Tag>
          {entry?.endpointMode && <Tag>{entry.endpointMode}</Tag>}
        </div>
        <span>{entry?.summary || '根据 transport 自动派生 provider、route role 和 trust level。'}</span>
      </div>
    );
  };
  const renderRemoteTransportStrategies = () => {
    const strategies = remoteNodeDefaults?.transportStrategies || [];
    if (!strategies.length) return null;
    return (
      <div className="settings-transport-strategies">
        {strategies.map((strategy: RemoteNodeTransportStrategy) => (
          <div className="settings-transport-strategy" key={strategy.id}>
            <div className="settings-transport-strategy-head">
              <strong>{strategy.title}</strong>
              <div className="settings-transport-strategy-tags">
                <Tag>{strategy.defaultTransport}</Tag>
                {strategy.provider && <Tag>{strategy.provider}</Tag>}
                {strategy.lane && <Tag>{strategy.lane}</Tag>}
              </div>
            </div>
            <p>{strategy.summary}</p>
            <div className="settings-transport-strategy-lanes">
              <span>data {formatTransportKinds(strategy.dataPlaneTransports)}</span>
              <span>bootstrap {formatTransportKinds(strategy.bootstrapTransports)}</span>
              <span>underlay {formatTransportKinds(strategy.underlayTransports)}</span>
            </div>
            {strategy.constraints[0] && (
              <span className="settings-transport-strategy-note">{strategy.constraints[0]}</span>
            )}
          </div>
        ))}
      </div>
    );
  };

  const syncControlPlaneProfiles = (profiles: ControlPlaneProfile[], preferredProfileId = '') => {
    const resolution = preferredProfileId
      ? selectActiveControlPlaneProfile(profiles, preferredProfileId)
      : syncStoredActiveControlPlaneProfile(profiles);
    setControlPlaneProfiles(profiles);
    setActiveControlPlaneId(resolution.profileId);
    return resolution;
  };

  const syncSavedControlPlaneProfiles = (preferredProfileId = '') => (
    syncControlPlaneProfiles(listControlPlaneProfiles(), preferredProfileId)
  );

  const applyRemoteNodeDefaultsToForms = (nodeDefaults: RemoteNodeDefaults, defaultControlEndpoint: string) => {
    setInviteFieldsValue({
      nodeId: '',
      name: '',
      controlEndpoint: defaultControlEndpoint,
      transportKind: nodeDefaults.transportKind,
      routeRole: nodeDefaults.routeRole,
      trustLevel: nodeDefaults.trustLevel,
      repoUrl: nodeDefaults.repoUrl,
      repoSubdir: nodeDefaults.repoSubdir,
      repoDir: nodeDefaults.repoDir,
      concurrency: 3,
      timeoutMs: 3000,
      executeConcurrency: 2,
      executeTimeoutMs: 30 * 60 * 1000,
      expiresMinutes: 60
    });
    setNodeFieldsValue({
      id: nodeDefaults.nodeId,
      name: nodeDefaults.name,
      transportKind: nodeDefaults.transportKind,
      routeRole: nodeDefaults.routeRole,
      trustLevel: nodeDefaults.trustLevel
    });
  };

  const clearRestartFallbackTimer = () => {
    if (restartFallbackTimerRef.current === null) return;
    window.clearTimeout(restartFallbackTimerRef.current);
    restartFallbackTimerRef.current = null;
  };

  const loadConfig = async () => {
    setLoading(true);
    setConfigLoaded(false);
    try {
      const [config, serverConfig] = await Promise.all([
        configAPI.get(),
        configAPI.getServer()
      ]);
      const [
        nodeDefaultsResult,
        nodesResult,
        nodeInvitesResult,
        devicesResult,
        deviceInvitesResult,
        endpointHintsResult
      ] = await Promise.allSettled([
        remoteNodesAPI.getDefaults(),
        remoteNodesAPI.list(),
        remoteNodesAPI.listInvites(),
        controlPlaneDevicesAPI.listDevices(),
        controlPlaneDevicesAPI.listInvites(),
        controlPlaneDevicesAPI.listEndpointHints()
      ]);
      const endpointHintsPayload = readSettledValue(endpointHintsResult, { ok: false, endpoints: [], warnings: [] });
      const endpointHints = endpointHintsPayload.endpoints || [];
      const defaultControlEndpoint = resolveDefaultControlEndpoint(endpointHints);
      const nodeDefaultsPayload = readSettledValue(nodeDefaultsResult, remoteNodeDefaults);
      const nodeDefaults = normalizeRemoteNodeDefaults(nodeDefaultsPayload);
      setRemoteNodeDefaults(nodeDefaults);
      setControlPlaneEndpointHints(endpointHints);
      setControlPlaneEndpointWarnings(normalizeEndpointHintWarnings(endpointHints, endpointHintsPayload.warnings));
      const deviceIdentity = resolveCurrentDeviceIdentity();
      const deviceInviteName = resolveDeviceInviteName(deviceIdentity);
      usageForm.setFieldsValue({
        threshold_pct: config.threshold_pct,
        active_refresh_interval: parseInterval(config.active_refresh_interval),
        background_refresh_interval: parseInterval(config.background_refresh_interval)
      });
      serverForm.setFieldsValue(serverConfig);
      controlPlaneForm.setFieldsValue({
        endpoint: defaultControlEndpoint,
        name: '当前 Control Plane'
      });
      pairControlPlaneForm.setFieldsValue({
        pairUrlOrCode: '',
        endpoint: defaultControlEndpoint,
        deviceName: deviceIdentity.name,
        platform: deviceIdentity.platform
      });
      deviceInviteForm.setFieldsValue({
        name: deviceInviteName,
        controlEndpoint: defaultControlEndpoint,
        scopes: DEFAULT_DEVICE_SCOPES,
        expiresMinutes: 10
      });
      applyRemoteNodeDefaultsToForms(nodeDefaults, defaultControlEndpoint);
      syncSavedControlPlaneProfiles();
      if (nodesResult.status === 'fulfilled') setRemoteNodes(nodesResult.value);
      if (nodeInvitesResult.status === 'fulfilled') setRemoteInvites(nodeInvitesResult.value);
      if (devicesResult.status === 'fulfilled') setControlPlaneDevices(devicesResult.value);
      if (deviceInvitesResult.status === 'fulfilled') setControlPlaneDeviceInvites(deviceInvitesResult.value);
    } catch (_error) {
      syncSavedControlPlaneProfiles();
      message.error('加载配置失败');
    } finally {
      setLoading(false);
      setConfigLoaded(true);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  useEffect(() => {
    const source = managementAPI.watch({
      onRestart: (event) => {
        setRestartEvent(event);
        if (event.status === 'queued' || event.status === 'starting') {
          setRestarting(true);
          return;
        }
        clearRestartFallbackTimer();
        setRestarting(false);
        if (event.status === 'started') {
          message.success('服务重启已启动');
          return;
        }
        if (event.status === 'failed') {
          message.error(event.message || '重启服务失败');
        }
      }
    });
    return () => {
      clearRestartFallbackTimer();
      source.close();
    };
  }, []);

  const parseInterval = (interval: string): number => {
    const match = interval.match(/^(\d+)([smh])$/);
    if (!match) return 60;
    const [, value, unit] = match;
    const num = parseInt(value);
    switch (unit) {
      case 's': return num;
      case 'm': return num * 60;
      case 'h': return num * 3600;
      default: return num;
    }
  };

  const formatInterval = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const config: UsageConfig = {
        threshold_pct: values.threshold_pct,
        active_refresh_interval: formatInterval(values.active_refresh_interval),
        background_refresh_interval: formatInterval(values.background_refresh_interval)
      };
      await configAPI.update(config);
      message.success('保存额度配置成功');
    } catch (_error) {
      message.error('保存额度配置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveServer = async (values: ServerConfig) => {
    setServerSaving(true);
    try {
      const nextConfig: ServerConfig = {
        host: values.openNetwork ? '0.0.0.0' : (values.host || '127.0.0.1'),
        port: Number(values.port || 9527),
        apiKey: String(values.apiKey || '').trim(),
        managementKey: String(values.managementKey || '').trim(),
        openNetwork: Boolean(values.openNetwork)
      };
      await configAPI.updateServer(nextConfig);
      serverForm.setFieldsValue(nextConfig);
      message.success('保存服务配置成功');
    } catch (_error) {
      message.error('保存服务配置失败');
    } finally {
      setServerSaving(false);
    }
  };

  const handleRestartServer = async () => {
    setRestarting(true);
    try {
      const result = await managementAPI.restart();
      if (result.job) {
        setRestartEvent(result.job);
      }
      clearRestartFallbackTimer();
      restartFallbackTimerRef.current = window.setTimeout(() => {
        setRestarting(false);
      }, 70_000);
    } catch (error: any) {
      clearRestartFallbackTimer();
      message.error(error?.response?.data?.message || error?.message || '重启服务失败');
      setRestarting(false);
    }
  };

  const handleSaveControlPlane = async (values: { endpoint?: string; name?: string; deviceToken?: string }) => {
    setControlPlaneSaving(true);
    try {
      const endpoint = normalizeControlPlaneEndpoint(String(values.endpoint || ''));
      const deviceToken = String(values.deviceToken || '').trim();
      if (!endpoint) {
        message.error('请输入有效的 Control Plane URL');
        return;
      }
      const existing = controlPlaneProfiles.find((profile) => profile.endpoint === endpoint) || null;
      const nextDeviceToken = deviceToken || existing?.deviceToken || '';
      const descriptor = await fetchControlPlaneDescriptor(endpoint);
      const profile = saveControlPlaneProfile({
        name: String(values.name || '').trim(),
        endpoint,
        descriptor,
        state: nextDeviceToken ? 'paired' : 'discovered',
        authState: nextDeviceToken ? 'paired' : 'unpaired',
        deviceToken: nextDeviceToken
      });
      if (nextDeviceToken) {
        await refreshControlPlaneDeviceState(profile);
      }
      syncSavedControlPlaneProfiles(nextDeviceToken ? profile.id : '');
      controlPlaneForm.setFieldsValue({
        endpoint: profile.endpoint,
        name: profile.name,
        deviceToken: ''
      });
      message.success('Control Plane 已保存');
    } catch (error: any) {
      message.error(error?.message || 'Control Plane 探测失败');
    } finally {
      setControlPlaneSaving(false);
    }
  };

  const handlePairControlPlane = async (values: {
    pairUrlOrCode?: string;
    endpoint?: string;
    deviceName?: string;
    platform?: string;
  }) => {
    setControlPlanePairing(true);
    try {
      const deviceIdentity = resolveCurrentDeviceIdentity();
      const paired = await pairControlPlaneDevice({
        pairUrlOrCode: String(values.pairUrlOrCode || '').trim(),
        endpoint: String(values.endpoint || '').trim(),
        deviceId: deviceIdentity.id,
        deviceName: String(values.deviceName || deviceIdentity.name).trim(),
        platform: String(values.platform || deviceIdentity.platform).trim()
      });
      const scopes = new Set(paired.device.scopes || []);
      let syncError = '';
      if (DEVICE_PROFILE_SYNC_SCOPES.every((scope) => scopes.has(scope))) {
        try {
          await refreshControlPlaneDeviceState(paired.profile);
        } catch (error: any) {
          syncError = error?.message || 'device_state_sync_failed';
          saveControlPlaneProfile({
            name: paired.profile.name,
            endpoint: paired.profile.endpoint,
            descriptor: paired.profile.descriptor,
            state: 'paired',
            authState: 'paired',
            deviceToken: paired.token,
            lastError: syncError
          });
        }
      }
      syncSavedControlPlaneProfiles(paired.profile.id);
      pairControlPlaneForm.setFieldsValue({
        pairUrlOrCode: '',
        endpoint: paired.profile.endpoint,
        deviceName: paired.device.name || values.deviceName || deviceIdentity.name,
        platform: paired.device.platform || values.platform || deviceIdentity.platform
      });
      controlPlaneForm.setFieldsValue({
        endpoint: paired.profile.endpoint,
        name: paired.profile.name,
        deviceToken: ''
      });
      if (syncError) {
        message.warning('Control Plane 已配对，摘要同步失败');
      } else {
        message.success('Control Plane 已配对');
      }
    } catch (error: any) {
      message.error(error?.message || 'Control Plane 配对失败');
    } finally {
      setControlPlanePairing(false);
    }
  };

  useEffect(() => {
    if (!configLoaded || pairIntentAppliedRef.current) return;
    const intent = parseControlPlanePairIntentFromSearch(getCurrentSearch());
    if (!intent.pairUrlOrCode) return;
    pairIntentAppliedRef.current = true;
    const deviceIdentity = resolveCurrentDeviceIdentity();
    const values = {
      pairUrlOrCode: intent.pairUrlOrCode,
      endpoint: intent.endpoint || getDefaultControlEndpoint(),
      deviceName: deviceIdentity.name,
      platform: deviceIdentity.platform
    };
    pairControlPlaneForm.setFieldsValue(values);
    if (intent.autoSubmit) {
      void handlePairControlPlane(values);
    }
  }, [configLoaded]);

  const handleRefreshControlPlane = async (profile: ControlPlaneProfile) => {
    setCheckingControlPlaneId(profile.id);
    try {
      if (profile.deviceToken) {
        await refreshControlPlaneDeviceState(profile);
      } else {
        const descriptor = await fetchControlPlaneDescriptor(profile.endpoint);
        saveControlPlaneProfile({
          name: profile.name,
          endpoint: profile.endpoint,
          descriptor,
          state: resolveHealthyProfileState(profile),
          authState: profile.authState,
          lastError: ''
        });
      }
      syncSavedControlPlaneProfiles();
      message.success(profile.deviceToken ? 'Control Plane 已同步' : 'Control Plane 探测正常');
    } catch (error: any) {
      saveControlPlaneProfile({
        name: profile.name,
        endpoint: profile.endpoint,
        descriptor: profile.descriptor,
        state: resolveFailedProfileState(profile),
        authState: profile.authState,
        deviceToken: profile.deviceToken,
        lastError: error?.message || 'descriptor_failed'
      });
      syncSavedControlPlaneProfiles();
      message.error(error?.message || 'Control Plane 探测失败');
    } finally {
      setCheckingControlPlaneId('');
    }
  };

  const handleRefreshAllControlPlanes = async () => {
    setRefreshingControlPlanes(true);
    try {
      const result = await refreshControlPlaneProfileStates(controlPlaneProfiles);
      syncControlPlaneProfiles(result.profiles, activeControlPlaneId);
      if (result.refreshed === 0 && result.failed === 0) {
        message.info('没有可同步的已配对 Control Plane');
      } else if (result.failed > 0) {
        message.warning(`已同步 ${result.refreshed} 个 Control Plane，${result.failed} 个失败`);
      } else {
        message.success(`已同步 ${result.refreshed} 个 Control Plane`);
      }
    } catch (error: any) {
      message.error(error?.message || '同步 Control Plane 失败');
    } finally {
      setRefreshingControlPlanes(false);
    }
  };

  const handleRemoveControlPlane = (profileId: string) => {
    syncControlPlaneProfiles(removeControlPlaneProfile(profileId));
    message.success('已移除 Control Plane');
  };

  const handleSelectControlPlane = (profileId: string) => {
    const resolution = selectActiveControlPlaneProfile(controlPlaneProfiles, profileId);
    setActiveControlPlaneId(resolution.profileId);
    message.success('已切换当前 Control Plane');
  };

  const refreshControlPlaneDevices = async () => {
    const [devices, invites, endpointHintsPayload] = await Promise.all([
      controlPlaneDevicesAPI.listDevices(),
      controlPlaneDevicesAPI.listInvites(),
      controlPlaneDevicesAPI.listEndpointHints().catch(() => ({ ok: false, endpoints: [], warnings: [] }))
    ]);
    setControlPlaneDevices(devices);
    setControlPlaneDeviceInvites(invites);
    setControlPlaneEndpointHints(endpointHintsPayload.endpoints || []);
    setControlPlaneEndpointWarnings(normalizeEndpointHintWarnings(endpointHintsPayload.endpoints, endpointHintsPayload.warnings));
  };

  const handleCreateDeviceInvite = async (values: ControlPlaneDeviceInviteCreatePayload & { expiresMinutes?: number }) => {
    setDeviceInviteCreating(true);
    try {
      const payload: ControlPlaneDeviceInviteCreatePayload = {
        name: String(values.name || '').trim(),
        controlEndpoint: String(values.controlEndpoint || getDefaultControlEndpoint()).trim(),
        scopes: Array.isArray(values.scopes) && values.scopes.length > 0 ? values.scopes : DEFAULT_DEVICE_SCOPES,
        expiresInMs: Math.max(1, Number(values.expiresMinutes || 10)) * 60 * 1000
      };
      const result = await controlPlaneDevicesAPI.createInvite(payload);
      setLatestDeviceInvite(result);
      await refreshControlPlaneDevices();
      message.success('已生成设备配对');
    } catch (error: any) {
      message.error(error?.response?.data?.message || '生成设备配对失败');
    } finally {
      setDeviceInviteCreating(false);
    }
  };

  const handleRevokeDevice = async (deviceId: string) => {
    setRevokingDeviceId(deviceId);
    try {
      await controlPlaneDevicesAPI.revokeDevice(deviceId);
      await refreshControlPlaneDevices();
      message.success('设备授权已撤销');
    } catch (error: any) {
      message.error(error?.response?.data?.message || '撤销设备失败');
    } finally {
      setRevokingDeviceId('');
    }
  };

  const handleSaveNode = async (values: RemoteNodeSavePayload) => {
    setNodeSaving(true);
    try {
      const transportDefaults = getRemoteTransportFormDefaults(values.transportKind);
      const transportKind = transportDefaults.transportKind;
      const payload: RemoteNodeSavePayload = {
        id: String(values.id || remoteNodeDefaults?.nodeId || '').trim(),
        name: String(values.name || remoteNodeDefaults?.name || '').trim(),
        endpoint: String(values.endpoint || '').trim(),
        transportKind,
        provider: transportDefaults.provider,
        routeRole: values.routeRole || transportDefaults.routeRole,
        trustLevel: values.trustLevel || transportDefaults.trustLevel,
        setupHint: String(values.setupHint || '').trim(),
        managementKey: String(values.managementKey || '').trim(),
        preferredTransports: [transportKind]
      };
      await remoteNodesAPI.save(payload);
      setRemoteNodes(await remoteNodesAPI.list());
      nodeForm.resetFields(['managementKey']);
      message.success('保存远程节点成功');
    } catch (error: any) {
      message.error(error?.response?.data?.message || '保存远程节点失败');
    } finally {
      setNodeSaving(false);
    }
  };

  const handleTestNode = async (nodeId: string) => {
    setTestingNodeId(nodeId);
    try {
      const result = await remoteNodesAPI.test(nodeId);
      const diagnostics = getRemoteNodeDiagnostics(result.result?.payload);
      setRemoteNodeTestResults((current) => ({
        ...current,
        [nodeId]: {
          ok: Boolean(result.ok),
          checkedAt: Date.now(),
          service: diagnostics?.service,
          message: result.message || result.error || ''
        }
      }));
      if (result.ok) {
        const serviceState = diagnostics?.service?.state;
        message.success(serviceState ? `远程节点连通正常，Relay ${serviceState}` : '远程节点连通正常');
      } else {
        message.error(result.message || result.error || '远程节点连通失败');
      }
    } catch (error: any) {
      setRemoteNodeTestResults((current) => ({
        ...current,
        [nodeId]: {
          ok: false,
          checkedAt: Date.now(),
          message: error?.response?.data?.message || '远程节点连通失败'
        }
      }));
      message.error(error?.response?.data?.message || '远程节点连通失败');
    } finally {
      setTestingNodeId('');
    }
  };

  const buildRemoteNodeInvitePayload = (
    values: RemoteNodeInviteCreatePayload & { expiresMinutes?: number },
    options: { includeLatestInvite?: boolean } = {}
  ): RemoteNodeInviteCreatePayload => {
    const transportDefaults = getRemoteTransportFormDefaults(values.transportKind);
    const transportKind = transportDefaults.transportKind;
    return {
      nodeId: String(values.nodeId || '').trim(),
      name: String(values.name || '').trim(),
      controlEndpoint: String(values.controlEndpoint || getDefaultControlEndpoint()).trim(),
      endpointHint: String(values.endpointHint || '').trim(),
      transportKind,
      provider: transportDefaults.provider,
      routeRole: values.routeRole || transportDefaults.routeRole,
      trustLevel: values.trustLevel || transportDefaults.trustLevel,
      setupHint: String(values.setupHint || '').trim(),
      preferredTransports: [transportKind],
      capabilities: DEFAULT_INVITE_CAPABILITIES,
      expiresInMs: Math.max(5, Number(values.expiresMinutes || 60)) * 60 * 1000,
      bootstrapTarget: values.bootstrapTarget || 'linux',
      repoUrl: String(values.repoUrl || '').trim(),
      repoSubdir: String(values.repoSubdir || remoteNodeDefaults?.repoSubdir || '').trim(),
      repoDir: String(values.repoDir || '').trim(),
      probeSshTargets: parseProbeTargets(values.probeSshTargets),
      probeTcpTargets: parseProbeTargets(values.probeTcpTargets),
      concurrency: normalizeInteger(values.concurrency, 3, 1, 32),
      timeoutMs: normalizeInteger(values.timeoutMs, 3000, 250, 120000),
      executeConcurrency: normalizeInteger(values.executeConcurrency, 2, 1, 16),
      executeTimeoutMs: normalizeInteger(values.executeTimeoutMs, 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
      ...(options.includeLatestInvite && latestInvite?.joinUrl ? { inviteUrl: latestInvite.joinUrl } : {})
    };
  };

  const handleCreateInvite = async (values: RemoteNodeInviteCreatePayload & { expiresMinutes?: number }) => {
    setInviteCreating(true);
    try {
      const payload = buildRemoteNodeInvitePayload(values);
      const result = await remoteNodesAPI.createInvite(payload);
      setLatestInvite(result);
      setLatestBootstrapPlan(result.bootstrap ? { ok: true, ...result.bootstrap } : null);
      setRemoteInvites(await remoteNodesAPI.listInvites());
      message.success(result.bootstrap?.script?.content ? '已生成 Bootstrap 脚本' : '已生成加入命令');
    } catch (error: any) {
      message.error(error?.response?.data?.message || '生成加入命令失败');
    } finally {
      setInviteCreating(false);
    }
  };

  const handlePreviewBootstrapPlan = async () => {
    setBootstrapPlanLoading(true);
    try {
      const values = inviteForm.getFieldsValue() as RemoteNodeInviteCreatePayload & { expiresMinutes?: number };
      const payload = buildRemoteNodeInvitePayload(values, { includeLatestInvite: true });
      const result = await remoteNodesAPI.getBootstrapPlan(payload);
      setLatestBootstrapPlan(result);
      message.success('已生成部署计划');
    } catch (error: any) {
      message.error(error?.response?.data?.message || '生成部署计划失败');
    } finally {
      setBootstrapPlanLoading(false);
    }
  };

  const handleRunBootstrapProbe = async () => {
    setBootstrapProbeRunning(true);
    try {
      const values = inviteForm.getFieldsValue() as RemoteNodeInviteCreatePayload & { expiresMinutes?: number };
      const payload = buildRemoteNodeInvitePayload(values, { includeLatestInvite: true });
      const result = await remoteNodesAPI.probeBootstrap(payload);
      setLatestBootstrapProbe(result);
      message.success('只读探测完成');
    } catch (error: any) {
      message.error(error?.response?.data?.message || '只读探测失败');
    } finally {
      setBootstrapProbeRunning(false);
    }
  };

  const handleExecuteBootstrapApply = async () => {
    const values = inviteForm.getFieldsValue() as RemoteNodeInviteCreatePayload & { expiresMinutes?: number };
    const missingInputs = resolveBootstrapApplyMissingInputs(values, latestInvite?.joinUrl || '');
    if (missingInputs.length) {
      message.error(`请先补齐部署输入：${formatBootstrapApplyMissingInputs(missingInputs)}`);
      return;
    }
    setBootstrapApplyRunning(true);
    try {
      const payload = {
        ...buildRemoteNodeInvitePayload(values, { includeLatestInvite: true }),
        execute: true,
        confirm: 'execute'
      } as RemoteNodeBootstrapApplyPayload;
      const result = await remoteNodesAPI.applyBootstrap(payload);
      setLatestBootstrapProbe((current) => ({
        ok: result.ok,
        command: current?.command || '',
        applyCommand: current?.applyCommand,
        applyExecuteCommand: result.command || current?.applyExecuteCommand,
        apply: result.apply,
        report: result.report
      }));
      const summary = result.apply.plan.summary;
      if (!result.ok) {
        const planMessage = result.apply.plan.error === 'bootstrap_apply_no_executable_actions'
          ? '没有可自动执行的 SSH-ready 任务；请先配置 SSH key、使用通过探测的 SSH 目标，或在目标机本地手动执行脚本。'
          : result.apply.plan.message;
        message.warning(
          planMessage
          || `SSH 部署完成，成功 ${summary.executed} 个，失败 ${summary.failed} 个`
        );
      } else if (summary.failed > 0) {
        message.warning(`SSH 部署完成，成功 ${summary.executed} 个，失败 ${summary.failed} 个`);
      } else {
        message.success(`SSH 部署完成，成功 ${summary.executed} 个`);
      }
    } catch (error: any) {
      const missingInputs = error?.response?.data?.requiredInputs;
      message.error(Array.isArray(missingInputs) && missingInputs.length
        ? `请先补齐部署输入：${formatBootstrapApplyMissingInputs(missingInputs)}`
        : error?.response?.data?.message || 'SSH 部署执行失败');
    } finally {
      setBootstrapApplyRunning(false);
    }
  };

  const handleInviteValuesChange = (changedValues: RemoteNodeInviteFormValues) => {
    setLatestInvite(null);
    setLatestBootstrapPlan(null);
    setLatestBootstrapProbe(null);
    const watchedPatch = pickInviteWatchedValues(changedValues);
    if (changedValues.transportKind) {
      const defaults = getRemoteTransportFormDefaults(changedValues.transportKind);
      inviteForm.setFieldsValue(defaults);
      Object.assign(watchedPatch, pickInviteWatchedValues(defaults));
    }
    if (Object.keys(watchedPatch).length > 0) {
      setInviteWatchedValues((current) => ({
        ...current,
        ...watchedPatch
      }));
    }
  };

  const handleNodeValuesChange = (changedValues: Partial<RemoteNodeSavePayload>) => {
    if (changedValues.transportKind) {
      applyRemoteTransportFormDefaults(nodeForm, remoteTransportDefaults, changedValues.transportKind);
      setNodeTransportKind(resolveRemoteTransportKind(changedValues.transportKind));
    }
  };

  const copyText = async (value: string, successMessage: string) => {
    const text = String(value || '').trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      message.success(successMessage);
    } catch (_error) {
      message.error('复制失败');
    }
  };

  const renderManualCommandActions = (
    manualCommands?: RemoteNodeBootstrapManualCommand[],
    options: { compact?: boolean } = {}
  ) => {
    const commands = normalizeBootstrapManualCommands(manualCommands);
    if (!commands.length) return null;
    return (
      <div className={options.compact ? 'settings-manual-command-list settings-manual-command-list--compact' : 'settings-manual-command-list'}>
        {commands.map((item) => (
          <div className="settings-manual-command-item" key={`${item.key}:${item.command}`}>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => copyText(item.command, `已复制 ${item.label}`)}
            >
              {item.label}
            </Button>
            {item.note && <span>{item.note}</span>}
          </div>
        ))}
      </div>
    );
  };

  const getRestartAlert = () => {
    if (!restartEvent && !restarting) return null;
    const status = restartEvent?.status || 'queued';
    if (status === 'failed') {
      return {
        type: 'error' as const,
        message: restartEvent?.message || '重启服务失败'
      };
    }
    if (status === 'started') {
      return {
        type: 'success' as const,
        message: restartEvent?.pid ? `服务重启已启动，pid ${restartEvent.pid}` : '服务重启已启动'
      };
    }
    return {
      type: 'info' as const,
      message: status === 'starting' ? '服务正在重启' : '服务重启已排队'
    };
  };

  const restartAlert = getRestartAlert();
  const currentDeviceIdentity = resolveCurrentDeviceIdentity();
  const controlPlaneOverview = summarizeControlPlaneProfiles(controlPlaneProfiles);
  const refreshableControlPlaneCount = controlPlaneProfiles.filter(isControlPlaneProfileRefreshable).length;
  const activeControlPlaneProfile = controlPlaneProfiles.find((profile) => profile.id === activeControlPlaneId) || null;
  const controlPlaneClientReadiness = summarizeControlPlaneClientReadiness(controlPlaneProfiles, activeControlPlaneId);
  const latestDevicePairUrl = latestDeviceInvite?.webPairUrl || latestDeviceInvite?.pairUrl || '';
  const latestDevicePairCode = latestDeviceInvite?.code || '';
  const latestDevicePairUrlIsLoopback = isLoopbackEndpoint(latestDevicePairUrl);
  const latestDevicePairWarnings = uniqueTextList([
    ...(latestDeviceInvite?.warnings || []),
    latestDevicePairUrlIsLoopback
      ? '当前配对链接指向 localhost，手机扫码会连到手机本机；请改用局域网候选、Tailscale/FRP/Cloudflare Tunnel 后重新生成。'
      : ''
  ]);
  const latestInviteJoinUrl = latestInvite?.joinUrl || '';
  const latestInviteJoinCommand = resolveInviteJoinCommand(latestInvite);
  const latestInviteWarnings = uniqueTextList([
    ...(latestInvite?.warnings || [])
  ]);
  const bootstrapApplyMissingInputs = resolveBootstrapApplyMissingInputs({
    controlEndpoint: inviteControlEndpoint ?? inviteForm.getFieldValue('controlEndpoint'),
    repoUrl: inviteRepoUrl ?? inviteForm.getFieldValue('repoUrl'),
    endpointHint: inviteEndpointHint ?? inviteForm.getFieldValue('endpointHint'),
    transportKind: inviteTransportKind ?? inviteForm.getFieldValue('transportKind')
  }, latestInviteJoinUrl);
  const bootstrapApplyBlockReason = bootstrapApplyMissingInputs.length
    ? `请先补齐部署输入：${formatBootstrapApplyMissingInputs(bootstrapApplyMissingInputs)}`
    : '';

  const renderBootstrapApplyPreview = () => {
    const apply = latestBootstrapProbe?.apply;
    const actions = apply?.plan.actions || [];
    if (!apply || actions.length === 0) return null;
    const summary = apply.plan.summary;
    return (
      <div className="settings-probe-apply-plan">
        <div className="settings-join-command-head">
          <strong>部署任务预览</strong>
          <Space size={6} wrap>
            <Tag>{apply.mode}</Tag>
            <Tag color="green">ssh {summary.executable}</Tag>
            <Tag color="gold">manual {summary.manual}</Tag>
            <Tag color="blue">needs input {summary.needsInput}</Tag>
            <Tag color="red">blocked {summary.blocked}</Tag>
            {latestBootstrapProbe?.applyCommand && (
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => copyText(latestBootstrapProbe.applyCommand || '', '已复制部署任务命令')}
              >
                复制 dry-run
              </Button>
            )}
            {latestBootstrapProbe?.applyExecuteCommand && summary.executable > 0 && (
              <Button
                size="small"
                icon={<CopyOutlined />}
                disabled={bootstrapApplyMissingInputs.length > 0}
                title={bootstrapApplyBlockReason || undefined}
                onClick={() => copyText(latestBootstrapProbe.applyExecuteCommand || '', '已复制 SSH 部署执行命令')}
              >
                复制 execute
              </Button>
            )}
            {summary.executable > 0 && (
              <Popconfirm
                title="执行 SSH-ready 部署任务"
                description={`将并行执行 ${summary.executable} 个 SSH bootstrap；不会执行 WinRM 或本地手动任务。`}
                okText="执行"
                cancelText="取消"
                onConfirm={handleExecuteBootstrapApply}
              >
                <Button
                  size="small"
                  type="primary"
                  loading={bootstrapApplyRunning}
                  disabled={bootstrapApplyMissingInputs.length > 0}
                  title={bootstrapApplyBlockReason || undefined}
                >
                  执行 SSH-ready
                </Button>
              </Popconfirm>
            )}
          </Space>
        </div>
        {summary.executable > 0 && bootstrapApplyMissingInputs.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message="执行前缺少部署输入"
            description={bootstrapApplyBlockReason}
          />
        )}
        {renderWarningAlert(apply.plan.warnings, '部署任务注意事项')}
        <div className="settings-probe-execution-list">
          {actions.map((action) => {
            const state = getBootstrapApplyStateMeta(action);
            return (
              <div className="settings-probe-execution-step" key={`${action.order}:${action.resultKey}`}>
                <div className="settings-probe-execution-main">
                  <span className="settings-probe-execution-order">{action.order}</span>
                  <span className="settings-probe-execution-copy">
                    <strong>{action.title}</strong>
                    <span>{action.target}</span>
                  </span>
                </div>
                <div className="settings-probe-execution-meta">
                  <Tag color={state.color}>{state.label}</Tag>
                  {action.channel && <Tag>{action.channel}</Tag>}
                  {action.command && (
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={() => copyText(action.command, '已复制部署命令')}
                    >
                      复制命令
                    </Button>
                  )}
                  {renderManualCommandActions(action.manualCommands, { compact: true })}
                </div>
                <p>{action.summary}</p>
                {action.note && <p>{action.note}</p>}
                {action.executionState === 'failed' && (
                  <p>exit {action.exitCode ?? 'unknown'}{action.timedOut ? ' timeout' : ''}</p>
                )}
                {action.stdout && <pre className="settings-probe-execution-log">{action.stdout}</pre>}
                {action.stderr && <pre className="settings-probe-execution-log settings-probe-execution-log--error">{action.stderr}</pre>}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderBootstrapPlanPanel = () => {
    const plan = latestBootstrapPlan?.plan;
    if (!plan) return null;
    const requiredInputs = uniqueTextList(plan.requiredInputs);
    const guidance = uniqueTextList([
      ...plan.prerequisites,
      ...plan.transportGuidance,
      ...plan.security.notes
    ]);
    const readinessChecks = plan.readinessChecks || [];
    return (
      <div className="settings-join-command settings-bootstrap-plan-panel">
        <div className="settings-join-command-head">
          <strong>部署计划</strong>
          <Space size={6} wrap>
            <Tag>{plan.target}</Tag>
            <Tag>{plan.channel}</Tag>
            <Tag>{plan.transportKind}</Tag>
            <Tag color={plan.security.containsSecrets ? 'red' : 'green'}>
              secrets {plan.security.containsSecrets ? 'yes' : 'no'}
            </Tag>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => copyText(plan.script.content, '已复制 Bootstrap 脚本')}
            >
              复制脚本
            </Button>
          </Space>
        </div>
        {requiredInputs.length ? (
          <Alert
            type="info"
            showIcon
            message="缺少输入"
            description={requiredInputs.join(', ')}
          />
        ) : null}
        {renderWarningAlert(plan.warnings, '部署注意事项')}
        {readinessChecks.length > 0 && (
          <div className="settings-bootstrap-readiness">
            {readinessChecks.map((check) => {
              const meta = getBootstrapReadinessMeta(check);
              return (
                <div className="settings-bootstrap-readiness-item" key={check.id}>
                  <div className="settings-bootstrap-readiness-head">
                    <strong>{check.id}</strong>
                    <Space size={4} wrap>
                      {check.required && <Tag color="red">必需</Tag>}
                      <Tag color={meta.color}>{meta.label}</Tag>
                    </Space>
                  </div>
                  <span>{check.message}</span>
                </div>
              );
            })}
          </div>
        )}
        <div className="settings-bootstrap-plan-steps">
          {plan.steps.map((step, index) => (
            <div className="settings-bootstrap-plan-step" key={step.id}>
              <div className="settings-bootstrap-plan-step-head">
                <span className="settings-probe-execution-order">{index + 1}</span>
                <strong>{step.title}</strong>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => copyText(step.command, '已复制执行命令')}
                >
                  复制
                </Button>
              </div>
              <pre>{step.command}</pre>
            </div>
          ))}
        </div>
        {guidance.length ? (
          <div className="settings-bootstrap-guidance">
            {guidance.slice(0, 8).map((item) => <span key={item}>{item}</span>)}
          </div>
        ) : null}
        <div className="settings-join-command-head">
          <strong>{formatBootstrapScriptTitle(plan.script.type)}</strong>
          <Button
            size="small"
            icon={<CopyOutlined />}
            onClick={() => copyText(plan.script.content, '已复制 Bootstrap 脚本')}
          >
            复制
          </Button>
        </div>
        <pre>{plan.script.content}</pre>
      </div>
    );
  };

  const renderControlPlaneSummary = (profile: ControlPlaneProfile) => {
    const descriptor = profile.descriptor;
    const status = getControlPlaneProfileStatus(profile.state);
    const managementCount = descriptor?.capabilities.management.length || 0;
    const transportCount = descriptor?.capabilities.transports.length || 0;
    const nodeSummary = summarizeControlPlaneProfileNodes(profile);
    return (
      <div className="settings-control-plane-summary">
        <Tag color={status.color}>{status.label}</Tag>
        {descriptor && <Tag color="blue">协议 v{descriptor.protocolVersion}</Tag>}
        {descriptor && <Tag>{managementCount} 个管理能力</Tag>}
        {descriptor && <Tag>{transportCount} 个 transport</Tag>}
        {profile.authState === 'paired' && <Tag color="green">Device Token</Tag>}
        {nodeSummary.total > 0 && (
          <Tag color={nodeSummary.online > 0 ? 'green' : 'default'}>
            {nodeSummary.online}/{nodeSummary.total} 节点在线
          </Tag>
        )}
        {nodeSummary.offline > 0 && <Tag color="red">{nodeSummary.offline} 个离线</Tag>}
        {nodeSummary.unknown > 0 && <Tag>{nodeSummary.unknown} 个未知</Tag>}
        {nodeSummary.dataPlaneTransports > 0 && <Tag color="blue">数据面 {nodeSummary.dataPlaneTransports}</Tag>}
        {nodeSummary.bootstrapTransports > 0 && <Tag color="cyan">引导 {nodeSummary.bootstrapTransports}</Tag>}
        {nodeSummary.underlayTransports > 0 && <Tag color="purple">底层 {nodeSummary.underlayTransports}</Tag>}
        {profile.lastStatusSyncAt > 0 && <Tag>{profile.activeAccountCount}/{profile.accountCount} 账号可用</Tag>}
        {profile.lastAccountsSyncAt > 0 && <Tag>{profile.schedulableAccountCount} 个可调度</Tag>}
        {profile.lastSessionsSyncAt > 0 && <Tag>{profile.sessionCount} 个会话</Tag>}
        {descriptor?.capabilities.devicePairing && <Tag color="cyan">Device Pairing</Tag>}
        {descriptor?.auth.managementKeyConfigured && <Tag color="gold">Management Key</Tag>}
        {descriptor?.auth.clientKeyConfigured && <Tag color="purple">Client Key</Tag>}
      </div>
    );
  };

  const basicSettingsContent = (
    <div className="settings-grid">
      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>账号调度</h2>
            <p>控制额度阈值和后台刷新节奏。</p>
          </div>
        </div>
        <Form
          form={usageForm}
          disabled={loading}
          layout="vertical"
          onFinish={handleSave}
          initialValues={{
            threshold_pct: 95,
            active_refresh_interval: 60,
            background_refresh_interval: 3600
          }}
        >
          <Form.Item
            name="threshold_pct"
            label="自动切换阈值 (%)"
            help="当账号剩余额度低于此百分比时，自动切换到下一个可用账号"
            rules={[
              { required: true, message: '请输入阈值' },
              { type: 'number', min: 0, max: 100, message: '阈值必须在 0-100 之间' }
            ]}
          >
            <NumericAddonInput min={0} max={100} addonAfter="%" />
          </Form.Item>

          <Form.Item
            name="active_refresh_interval"
            label="活跃刷新间隔 (秒)"
            help="正在使用的账号额度刷新间隔时间"
            rules={[
              { required: true, message: '请输入刷新间隔' },
              { type: 'number', min: 10, message: '间隔不能小于 10 秒' }
            ]}
          >
            <NumericAddonInput min={10} addonAfter="秒" />
          </Form.Item>

          <Form.Item
            name="background_refresh_interval"
            label="后台刷新间隔 (秒)"
            help="未使用账号的额度刷新间隔时间"
            rules={[
              { required: true, message: '请输入刷新间隔' },
              { type: 'number', min: 60, message: '间隔不能小于 60 秒' }
            ]}
          >
            <NumericAddonInput min={60} addonAfter="秒" />
          </Form.Item>

          <Form.Item>
            <Space className="settings-actions">
              <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
                保存额度设置
              </Button>
              <Button onClick={loadConfig}>重置</Button>
            </Space>
          </Form.Item>
        </Form>
      </section>

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>服务配置</h2>
            <p>管理监听地址、端口和本地接口密钥。</p>
          </div>
        </div>
        <Form
          form={serverForm}
          disabled={loading}
          layout="vertical"
          onFinish={handleSaveServer}
          initialValues={{
            host: '127.0.0.1',
            port: 9527,
            apiKey: '',
            managementKey: '',
            openNetwork: false
          }}
        >
          <Alert
            type="info"
            showIcon
            className="settings-inline-alert"
            message="开启开放网络后，Server 会监听 0.0.0.0。保存配置后，需要点击“一键重启服务”才会生效。"
          />
          {restartAlert && (
            <Alert
              type={restartAlert.type}
              showIcon
              className="settings-inline-alert settings-restart-alert animate__animated animate__fadeIn animate__faster"
              message={restartAlert.message}
            />
          )}

          <Form.Item
            name="openNetwork"
            label="开放网络访问"
            valuePropName="checked"
          >
            <Switch checkedChildren="开放" unCheckedChildren="仅本机" />
          </Form.Item>

          <Form.Item shouldUpdate noStyle>
            {() => {
              const openNetwork = serverForm.getFieldValue('openNetwork');
              return (
                <Form.Item
                  name="host"
                  label="监听地址"
                  help={openNetwork ? '开放网络时会自动使用 0.0.0.0' : '默认仅监听本机 127.0.0.1'}
                >
                  <Input disabled={openNetwork} placeholder="127.0.0.1" />
                </Form.Item>
              );
            }}
          </Form.Item>

          <Form.Item
            name="port"
            label="端口"
            rules={[
              { required: true, message: '请输入端口' },
              { type: 'number', min: 1, max: 65535, message: '端口必须在 1-65535 之间' }
            ]}
          >
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="apiKey"
            label="API Key"
            help="用于访问 /v1 接口的客户端密钥。留空表示继续使用默认 dummy。"
          >
            <Input.Password autoComplete="new-password" placeholder="例如 sk-local-xxxx" />
          </Form.Item>

          <Form.Item
            name="managementKey"
            label="Management Key"
            help="用于 /v0/management 管理接口。可留空。"
          >
            <Input.Password autoComplete="new-password" placeholder="可选" />
          </Form.Item>

          <Form.Item>
            <Space className="settings-actions">
              <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={serverSaving}>
                保存服务配置
              </Button>
              <Button icon={<ReloadOutlined />} onClick={handleRestartServer} loading={restarting}>
                一键重启服务
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </section>
    </div>
  );

  const renderRemoteNodeTestResult = (nodeId: string) => {
    const result = remoteNodeTestResults[nodeId];
    if (!result) return null;
    const service = result.service;
    const state = getRelayServiceStateMeta(service?.state, service?.running);
    const issues = Array.isArray(service?.issues) ? service.issues : [];
    const actions = (Array.isArray(service?.nextActions) ? service.nextActions : [])
      .filter((action) => action?.command)
      .slice(0, 2);

    return (
      <div className="settings-node-test-result">
        <div className="settings-node-test-summary">
          <Tag color={result.ok ? 'green' : 'red'}>{result.ok ? '测试通过' : '测试失败'}</Tag>
          {service && <Tag color={state.color}>{state.label}</Tag>}
          {service && <Tag>running {service.running ? 'yes' : 'no'}</Tag>}
          <span>{formatTimestamp(result.checkedAt)}</span>
        </div>
        {result.message && <p>{result.message}</p>}
        {issues.length > 0 && (
          <div className="settings-node-test-issues">
            {issues.slice(0, 2).map((issue) => (
              <span key={`${issue.code || issue.message}`}>
                {issue.code || 'issue'}: {issue.message || ''}
              </span>
            ))}
          </div>
        )}
        {actions.length > 0 && (
          <div className="settings-node-test-actions">
            {actions.map((action) => (
              <Button
                key={`${action.label}:${action.command}`}
                size="small"
                icon={<CopyOutlined />}
                onClick={() => copyText(action.command || '', '已复制诊断命令')}
              >
                {action.label || '复制命令'}
              </Button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const remoteNodesContent = (
    <div className="settings-grid">
      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>一键加入</h2>
            <p>为目标机器生成一次性命令，执行后自动注册到当前 Control Plane。</p>
          </div>
        </div>
        <Form
          form={inviteForm}
          layout="vertical"
          onFinish={handleCreateInvite}
          onValuesChange={handleInviteValuesChange}
          initialValues={{
            controlEndpoint: getDefaultControlEndpoint(),
            ...getRemoteTransportFormDefaults(DEFAULT_REMOTE_TRANSPORT_KIND),
            routeRole: 'data-plane',
            bootstrapTarget: 'linux',
            concurrency: 3,
            timeoutMs: 3000,
            executeConcurrency: 2,
            executeTimeoutMs: 30 * 60 * 1000,
            expiresMinutes: 60
          }}
        >
          <Form.Item
            name="controlEndpoint"
            label="Control Endpoint"
            rules={[{ required: true, message: '请输入 Control Endpoint' }]}
          >
            <Input placeholder="https://control.example.com" />
          </Form.Item>
          {renderControlEndpointHints(
            controlPlaneEndpointHints,
            controlPlaneEndpointWarnings,
            (endpoint) => setInviteFieldsValue({ controlEndpoint: endpoint })
          )}

          <Form.Item name="transportKind" label="首选 Transport">
            <Select options={REMOTE_TRANSPORT_KIND_OPTIONS} />
          </Form.Item>
          {renderRemoteTransportSummary(inviteTransportKind)}
          {renderRemoteTransportStrategies()}

          <details className="settings-advanced-fields">
            <summary>高级路由覆盖</summary>
            <Form.Item name="routeRole" label="Route Role">
              <Select options={REMOTE_TRANSPORT_ROUTE_ROLE_OPTIONS} />
            </Form.Item>

            <Form.Item name="trustLevel" label="Trust Level">
              <Select options={REMOTE_TRANSPORT_TRUST_LEVEL_OPTIONS} />
            </Form.Item>
          </details>

          <Form.Item name="bootstrapTarget" label="目标系统">
            <Select options={REMOTE_BOOTSTRAP_TARGET_OPTIONS} />
          </Form.Item>

          <details className="settings-advanced-fields">
            <summary>高级身份覆盖</summary>
            <Form.Item
              name="nodeId"
              label="覆盖节点 ID"
              help="留空时由目标机器按 machine-id/电脑名自动生成。"
            >
              <Input placeholder="自动使用目标机本机 ID" />
            </Form.Item>

            <Form.Item
              name="name"
              label="覆盖显示名称"
              help="留空时由目标机器使用电脑名称。"
            >
              <Input placeholder="自动使用目标机电脑名称" />
            </Form.Item>
          </details>

          <Form.Item
            name="repoUrl"
            label="Repo URL"
            help="默认读取当前仓库 origin；SSH origin 会转成 HTTPS clone URL，减少目标机 SSH key 配置。"
            rules={[{ required: true, message: '请输入 Repo URL' }]}
          >
            <Input placeholder="https://github.com/your-org/ai_home.git" />
          </Form.Item>

          <Form.Item name="repoDir" label="Repo Dir">
            <Input placeholder={'可选，例如 /opt/ai_home 或 C:\\Users\\model\\ai_home'} />
          </Form.Item>

          <Form.Item
            name="probeSshTargets"
            label="SSH 探测目标"
            help="可选；点击只读探测时并行执行 SSH 诊断，不写远端文件。"
          >
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder={'model@192.168.3.8\nmodel@192.168.3.22'}
            />
          </Form.Item>

          <Form.Item
            name="probeTcpTargets"
            label="TCP 探测目标"
            help="可选；点击只读探测时检查 Windows/RDP/SMB/WinRM 端口，不执行远端命令。"
          >
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder="192.168.3.76"
            />
          </Form.Item>

          <details className="settings-advanced-fields">
            <summary>高级探测/执行参数</summary>
            <Form.Item name="concurrency" label="探测并发">
              <InputNumber min={1} max={32} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="timeoutMs" label="探测超时">
              <NumericAddonInput min={250} max={120000} addonAfter="ms" />
            </Form.Item>
            <Form.Item name="executeConcurrency" label="SSH 部署并发">
              <InputNumber min={1} max={16} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="executeTimeoutMs" label="SSH 部署超时">
              <NumericAddonInput min={1000} max={24 * 60 * 60 * 1000} addonAfter="ms" />
            </Form.Item>
          </details>

          <Form.Item name="endpointHint" label="Endpoint Hint">
            <Input placeholder="可选，例如 http://100.64.0.20:9527" />
          </Form.Item>

          <Form.Item name="setupHint" label="Setup Hint">
            <Input placeholder="可选，例如 已通过 VPN 暴露本地端口" />
          </Form.Item>

          <Form.Item
            name="expiresMinutes"
            label="有效期"
            rules={[
              { type: 'number', min: 5, max: 1440, message: '有效期必须在 5-1440 分钟之间' }
            ]}
          >
            <NumericAddonInput min={5} max={1440} addonAfter="分钟" />
          </Form.Item>

          <Form.Item>
            <Space className="settings-actions" wrap>
              <Button type="primary" htmlType="submit" icon={<PlusOutlined />} loading={inviteCreating}>
                生成加入命令
              </Button>
              <Button
                htmlType="button"
                icon={<FileTextOutlined />}
                loading={bootstrapPlanLoading}
                onClick={handlePreviewBootstrapPlan}
              >
                部署计划
              </Button>
              <Button
                htmlType="button"
                icon={<SearchOutlined />}
                loading={bootstrapProbeRunning}
                onClick={handleRunBootstrapProbe}
              >
                只读探测
              </Button>
            </Space>
          </Form.Item>
        </Form>

        {renderBootstrapPlanPanel()}

        {latestBootstrapProbe && (
          <div className="settings-join-command settings-probe-panel">
            <div className="settings-join-command-head">
              <strong>只读探测结果</strong>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => copyText(latestBootstrapProbe.command, '已复制探测命令')}
              >
                复制命令
              </Button>
            </div>
            <div className="settings-probe-summary">
              <Tag>targets {latestBootstrapProbe.report.summary.total}</Tag>
              <Tag color="green">ssh {latestBootstrapProbe.report.summary.reachableSsh}</Tag>
              <Tag color="gold">ssh auth {latestBootstrapProbe.report.summary.authRequiredSsh || 0}</Tag>
              <Tag color="blue">winrm {latestBootstrapProbe.report.summary.winrm}</Tag>
              <Tag color="gold">local {latestBootstrapProbe.report.summary.localManual}</Tag>
              <Tag color="red">unreachable {latestBootstrapProbe.report.summary.unreachable}</Tag>
            </div>
            {renderWarningAlert(latestBootstrapProbe.report.warnings, '探测注意事项')}
            {renderBootstrapApplyPreview()}
            {latestBootstrapProbe.report.executionPlan?.length ? (
              <div className="settings-probe-execution-plan">
                <strong>建议执行顺序</strong>
                <div className="settings-probe-execution-list">
                  {latestBootstrapProbe.report.executionPlan.map((step) => {
                    const status = getProbeExecutionStatusMeta(step);
                    const copyAction = getProbeExecutionCopyAction(step);
                    return (
                      <div className="settings-probe-execution-step" key={`${step.order}:${step.resultKey}`}>
                        <div className="settings-probe-execution-main">
                          <span className="settings-probe-execution-order">{step.order}</span>
                          <span className="settings-probe-execution-copy">
                            <strong>{step.title}</strong>
                            <span>{step.target}</span>
                          </span>
                        </div>
                        <div className="settings-probe-execution-meta">
                          <Tag color={status.color}>{status.label}</Tag>
                          {step.channel && <Tag>{step.channel}</Tag>}
                          {copyAction && (
                            <Button
                              size="small"
                              icon={<CopyOutlined />}
                              onClick={() => copyText(step.command, copyAction.successMessage)}
                            >
                              {copyAction.label}
                            </Button>
                          )}
                          {renderManualCommandActions(step.manualCommands, { compact: true })}
                        </div>
                        <p>{step.summary}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="settings-probe-results">
              {latestBootstrapProbe.report.results.map((result) => {
                const status = getProbeStatus(result);
                const meta = getProbeResultMeta(result);
                const copyActions = getProbeCopyActions(result);
                return (
                  <div className="settings-probe-result" key={`${result.kind}:${result.target}`}>
                    <div className="settings-probe-result-head">
                      <strong>{getProbeResultTitle(result)}</strong>
                      <Space size={4} wrap>
                        <Tag color={status.color}>{status.label}</Tag>
                        {result.bootstrapAction?.channel && <Tag>{result.bootstrapAction.channel}</Tag>}
                        {copyActions.map((action) => (
                          <Button
                            key={action.key}
                            size="small"
                            icon={<CopyOutlined />}
                            onClick={() => copyText(action.value, action.successMessage)}
                          >
                            {action.label}
                          </Button>
                        ))}
                      </Space>
                    </div>
                    <div className="settings-probe-meta">
                      {meta.map((item) => <span key={item}>{item}</span>)}
                      {result.bootstrapScript?.type && <span>script: {result.bootstrapScript.type}</span>}
                    </div>
                    {result.bootstrapScript?.requiredInputs?.length ? (
                      <p className="settings-probe-note">
                        缺少输入：{result.bootstrapScript.requiredInputs.join(', ')}
                      </p>
                    ) : null}
                    {result.bootstrapAction?.note && (
                      <p className="settings-probe-note">{result.bootstrapAction.note}</p>
                    )}
                    <pre>{result.recommendation}</pre>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {latestInviteJoinUrl && (
          <div className="settings-join-command">
            <div className="settings-join-command-head">
              <strong>加入命令</strong>
              <Space size={6}>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => copyText(latestInviteJoinCommand, '已复制加入命令')}
                >
                  复制命令
                </Button>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => copyText(latestInviteJoinUrl, '已复制加入链接')}
                >
                  复制 URL
                </Button>
              </Space>
            </div>
            <div className="settings-pair-body">
              <div className="settings-pair-qr">
                <QRCode value={latestInviteJoinUrl} size={168} bordered={false} />
              </div>
              <div className="settings-pair-detail">
                {renderWarningAlert(latestInviteWarnings, '加入前确认 Control Endpoint')}
                <div className="settings-pair-code">{latestInvite?.code}</div>
                <pre>{latestInviteJoinCommand}</pre>
              </div>
            </div>
          </div>
        )}

        {latestInvite?.probeCommand && (
          <div className="settings-join-command">
            <div className="settings-join-command-head">
              <strong>多节点探测命令</strong>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => copyText(latestInvite.probeCommand || '', '已复制探测命令')}
              >
                复制
              </Button>
            </div>
            <pre>{latestInvite.probeCommand}</pre>
            {renderWarningAlert(latestInviteWarnings, '探测前确认 Control Endpoint')}
          </div>
        )}

      </section>

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>添加远程节点</h2>
            <p>先接入 direct、FRP、SSH、本地转发或 overlay 提供的 HTTP endpoint。</p>
          </div>
        </div>
        <Form
          form={nodeForm}
          layout="vertical"
          onFinish={handleSaveNode}
          onValuesChange={handleNodeValuesChange}
          initialValues={{
            ...getRemoteTransportFormDefaults(DEFAULT_REMOTE_TRANSPORT_KIND),
            routeRole: 'data-plane',
          }}
        >
          <div className="settings-derived-grid settings-derived-grid--identity">
            {buildRemoteNodeDefaultPreview(
              remoteNodeDefaults,
              getRemoteTransportFormDefaults(nodeTransportKind)
            ).map((item) => (
              <div className="settings-derived-cell" key={item.id}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>

          <Form.Item
            name="id"
            label="覆盖节点 ID"
            help="留空使用默认节点 ID；登记其他机器时才需要覆盖。"
          >
            <Input placeholder={remoteNodeDefaults?.nodeId || '默认节点 ID 加载中'} />
          </Form.Item>

          <Form.Item
            name="name"
            label="覆盖显示名称"
            help="留空使用当前电脑名称。"
          >
            <Input placeholder={remoteNodeDefaults?.name || '默认电脑名称加载中'} />
          </Form.Item>

          <Form.Item
            name="endpoint"
            label="管理入口"
            help={getRemoteTransportEndpointHelp(remoteTransportCatalog, nodeTransportKind)}
            rules={isRemoteTransportEndpointRequired(remoteTransportCatalog, nodeTransportKind)
              ? [{ required: true, message: '请输入管理入口' }]
              : []}
          >
            <Input placeholder={getRemoteTransportEndpointPlaceholder(remoteTransportCatalog, nodeTransportKind)} />
          </Form.Item>

          <Form.Item name="transportKind" label="Transport">
            <Select options={REMOTE_TRANSPORT_KIND_OPTIONS} />
          </Form.Item>
          {renderRemoteTransportSummary(nodeTransportKind)}

          <details className="settings-advanced-fields">
            <summary>高级路由覆盖</summary>
            <Form.Item name="routeRole" label="Route Role">
              <Select options={REMOTE_TRANSPORT_ROUTE_ROLE_OPTIONS} />
            </Form.Item>

            <Form.Item name="trustLevel" label="Trust Level">
              <Select options={REMOTE_TRANSPORT_TRUST_LEVEL_OPTIONS} />
            </Form.Item>
          </details>

          <Form.Item name="setupHint" label="Setup Hint">
            <Input placeholder="可选，例如 用户托管的本地端口映射" />
          </Form.Item>

          <Form.Item
            name="managementKey"
            label="Management Key"
            help="只保存在本机 secret store，不会出现在节点列表响应里。"
          >
            <Input.Password autoComplete="new-password" placeholder="远程节点的 management key" />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={nodeSaving}>
              保存远程节点
            </Button>
          </Form.Item>
        </Form>
      </section>

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>已配置节点</h2>
            <p>节点能力通过 Control Plane 聚合，业务页面后续按节点维度读取。</p>
          </div>
        </div>
        <div className="settings-node-list">
          {remoteNodes.length === 0 ? (
            <Alert type="info" showIcon message="暂无远程节点" />
          ) : remoteNodes.map((node) => {
            const connection = getRemoteNodeConnectionMeta(node);
            return (
              <div className="settings-node-item" key={node.id}>
                <div className="settings-node-main">
                  <strong>{node.name || node.id}</strong>
                  <span>{node.id}</span>
                </div>
                <div className="settings-node-meta">
                  <Tag color={connection.color}>{connection.label}</Tag>
                  <Tag>{connection.detail}</Tag>
                  {(node.transports || []).map((transport) => (
                    <Space key={transport.id} size={4} wrap>
                      <Tag>{transport.kind}</Tag>
                      <Tag color={getRemoteTransportStatusColor(transport.status)}>{transport.status || 'unknown'}</Tag>
                      {transport.provider && <Tag>{transport.provider}</Tag>}
                      <Tag>{transport.routeRole}</Tag>
                      <Tag>{transport.trustLevel}</Tag>
                    </Space>
                  ))}
                </div>
                <Button size="small" loading={testingNodeId === node.id} onClick={() => handleTestNode(node.id)}>
                  测试连接
                </Button>
                {renderRemoteNodeTestResult(node.id)}
              </div>
            );
          })}
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>加入记录</h2>
            <p>历史 invite 只保留 hash 后状态，加入命令只在创建时显示。</p>
          </div>
        </div>
        <div className="settings-invite-list">
          {remoteInvites.length === 0 ? (
            <Alert type="info" showIcon message="暂无加入记录" />
          ) : remoteInvites.map((invite) => {
            const status = formatInviteStatus(invite);
            return (
              <div className="settings-invite-item" key={invite.id}>
                <div className="settings-node-main">
                  <strong>{invite.name || invite.nodeId || invite.id}</strong>
                  <span>{invite.nodeId || invite.id}</span>
                </div>
                <div className="settings-node-meta">
                  <Tag>{invite.transportKind}</Tag>
                  {invite.provider && <Tag>{invite.provider}</Tag>}
                  <Tag>{invite.routeRole}</Tag>
                  <Tag>{invite.trustLevel}</Tag>
                  <Tag color={status.color}>{status.label}</Tag>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );

  const controlPlanesContent = (
    <div className="settings-grid">
      <section className="settings-panel settings-panel--mobile-client">
        <div className="settings-panel-head">
          <div>
            <h2>本机/手机控制面</h2>
            <p>当前浏览器就是一个 client，可在本机保存多个 Control Plane，并按当前选择读取节点、账号和会话。</p>
          </div>
        </div>
        <div className="settings-mobile-client-overview">
          <div className="settings-mobile-client-card">
            <span>当前设备</span>
            <strong>{currentDeviceIdentity.name}</strong>
            <em>{currentDeviceIdentity.id}</em>
            <div className="settings-mobile-client-tags">
              <Tag>{currentDeviceIdentity.platform}</Tag>
              <Tag color={MOBILE_DEVICE_PLATFORMS.has(currentDeviceIdentity.platform) ? 'green' : 'blue'}>
                {MOBILE_DEVICE_PLATFORMS.has(currentDeviceIdentity.platform) ? 'mobile client' : 'web client'}
              </Tag>
            </div>
          </div>
          <div className="settings-mobile-client-card settings-mobile-client-card--server">
            <span>当前服务器</span>
            <strong>{formatActiveControlPlaneLabel(activeControlPlaneProfile)}</strong>
            <em>{formatActiveControlPlaneEndpoint(activeControlPlaneProfile)}</em>
            <div className="settings-mobile-client-switch">
              <Select
                value={activeControlPlaneId || undefined}
                placeholder="配对服务器"
                disabled={controlPlaneProfiles.length === 0}
                onChange={handleSelectControlPlane}
                options={controlPlaneProfiles.map((profile) => ({
                  value: profile.id,
                  label: profile.name || profile.endpoint || profile.id
                }))}
              />
              <Button
                icon={<ReloadOutlined />}
                disabled={!activeControlPlaneProfile}
                loading={checkingControlPlaneId === activeControlPlaneProfile?.id}
                onClick={() => activeControlPlaneProfile && handleRefreshControlPlane(activeControlPlaneProfile)}
              >
                同步当前
              </Button>
              <Button
                icon={<ReloadOutlined />}
                disabled={refreshableControlPlaneCount === 0}
                loading={refreshingControlPlanes}
                onClick={handleRefreshAllControlPlanes}
              >
                同步全部
              </Button>
              <Button
                icon={<PlusOutlined />}
                loading={deviceInviteCreating}
                onClick={() => deviceInviteForm.submit()}
              >
                生成设备配对
              </Button>
            </div>
          </div>
          <div className="settings-mobile-client-stats">
            <span><strong>{controlPlaneOverview.total}</strong>服务器</span>
            <span><strong>{controlPlaneOverview.paired}</strong>已配对</span>
            <span><strong>{controlPlaneOverview.ready}</strong>可用</span>
            <span><strong>{controlPlaneOverview.nodes}</strong>节点</span>
            <span><strong>{controlPlaneOverview.schedulableAccounts}</strong>可调度账号</span>
            <span><strong>{controlPlaneOverview.sessions}</strong>会话</span>
          </div>
          <div className="settings-mobile-client-readiness">
            {controlPlaneClientReadiness.map((item) => {
              const status = getControlPlaneClientReadinessStatus(item.status);
              return (
                <div className="settings-mobile-client-readiness-item" key={item.id}>
                  <div>
                    <strong>{item.label}</strong>
                    <span>{item.detail}</span>
                  </div>
                  <Tag color={status.color}>{status.label}</Tag>
                </div>
              );
            })}
          </div>
        </div>
      </section>
      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>配对手机/设备</h2>
            <p>生成一次性配对入口，手机/PWA 消费后保存当前 Control Plane 的 device token。</p>
          </div>
        </div>
        <Form
          form={deviceInviteForm}
          layout="vertical"
          onFinish={handleCreateDeviceInvite}
          initialValues={{
            name: resolveDeviceInviteName(resolveCurrentDeviceIdentity()),
            controlEndpoint: getDefaultControlEndpoint(),
            scopes: DEFAULT_DEVICE_SCOPES,
            expiresMinutes: 10
          }}
        >
          <Form.Item name="name" label="设备名称">
            <Input placeholder="iPhone / Android / iPad" />
          </Form.Item>

          <Form.Item
            name="controlEndpoint"
            label="Control Endpoint"
            rules={[{ required: true, message: '请输入 Control Endpoint' }]}
          >
            <Input placeholder="https://aih.example.com" />
          </Form.Item>
          {renderControlEndpointHints(
            controlPlaneEndpointHints,
            controlPlaneEndpointWarnings,
            (endpoint) => deviceInviteForm.setFieldsValue({ controlEndpoint: endpoint })
          )}

          <Form.Item name="scopes" label="权限范围">
            <Select mode="multiple" options={DEVICE_SCOPE_OPTIONS} />
          </Form.Item>

          <Form.Item
            name="expiresMinutes"
            label="有效期"
            rules={[
              { type: 'number', min: 1, max: 1440, message: '有效期必须在 1-1440 分钟之间' }
            ]}
          >
            <NumericAddonInput min={1} max={1440} addonAfter="分钟" />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />} loading={deviceInviteCreating}>
              生成设备配对
            </Button>
          </Form.Item>
        </Form>

        {latestDevicePairUrl && (
          <div className="settings-join-command">
            <div className="settings-join-command-head">
              <strong>手机配对入口</strong>
              <Space size={6}>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => copyText(latestDevicePairCode, '已复制配对码')}
                >
                  复制 Code
                </Button>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => copyText(latestDevicePairUrl, '已复制配对链接')}
                >
                  复制 URL
                </Button>
              </Space>
            </div>
            {renderWarningAlert(latestDevicePairWarnings, '配对前确认 Control Endpoint')}
            <div className="settings-pair-body">
              <div className="settings-pair-qr">
                <QRCode value={latestDevicePairUrl} size={168} bordered={false} />
              </div>
              <div className="settings-pair-detail">
                <div className="settings-pair-code">{latestDevicePairCode}</div>
                <pre>{latestDevicePairUrl}</pre>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>通过配对添加 Control Plane</h2>
            <p>粘贴 pair URL 或输入 code + endpoint，完成后保存为本机 profile。</p>
          </div>
        </div>
        <Form
          form={pairControlPlaneForm}
          layout="vertical"
          onFinish={handlePairControlPlane}
          initialValues={{
            pairUrlOrCode: '',
            endpoint: getDefaultControlEndpoint(),
            deviceName: resolveCurrentDeviceIdentity().name,
            platform: resolveCurrentDeviceIdentity().platform
          }}
        >
          <Form.Item
            name="pairUrlOrCode"
            label="Pair URL / Code"
            rules={[{ required: true, message: '请输入 Pair URL 或 Code' }]}
          >
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder="https://aih.example.com/ui/settings?pair=... 或 https://aih.example.com/v0/node-rpc/device-pair?code=..."
            />
          </Form.Item>

          <Form.Item name="endpoint" label="Control Endpoint">
            <Input placeholder="https://aih.example.com" />
          </Form.Item>

          <Form.Item name="deviceName" label="本机名称">
            <Input placeholder="iPhone / Android / Web" />
          </Form.Item>

          <Form.Item name="platform" label="Platform">
            <Input placeholder="ios / android / web" />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<LinkOutlined />} loading={controlPlanePairing}>
              配对并保存
            </Button>
          </Form.Item>
        </Form>
      </section>

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>已配对设备</h2>
            <p>设备 token 只在配对时返回一次；撤销后该设备不能再读取控制面摘要。</p>
          </div>
        </div>
        <div className="settings-device-list">
          {controlPlaneDevices.length === 0 ? (
            <Alert type="info" showIcon message="暂无已配对设备" />
          ) : controlPlaneDevices.map((device) => (
            <div className="settings-device-item" key={device.id}>
              <div className="settings-node-main">
                <strong>{device.name || device.id}</strong>
                <span>{device.platform || device.id}</span>
              </div>
              <div className="settings-node-meta">
                <Tag color={device.state === 'revoked' ? 'red' : 'green'}>
                  {device.state === 'revoked' ? '已撤销' : '已配对'}
                </Tag>
                {device.scopes.map((scope) => <Tag key={scope}>{scope.replace(':read', '')}</Tag>)}
                <Tag>最近 {formatTimestamp(device.lastSeenAt)}</Tag>
              </div>
              <Popconfirm
                title="撤销设备授权"
                description="撤销后该设备需要重新配对。"
                okText="撤销"
                cancelText="取消"
                onConfirm={() => handleRevokeDevice(device.id)}
                disabled={device.state === 'revoked'}
              >
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  loading={revokingDeviceId === device.id}
                  disabled={device.state === 'revoked'}
                >
                  撤销
                </Button>
              </Popconfirm>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>设备配对记录</h2>
            <p>历史 invite 不保存明文配对码，只保留状态和消费设备。</p>
          </div>
        </div>
        <div className="settings-invite-list">
          {controlPlaneDeviceInvites.length === 0 ? (
            <Alert type="info" showIcon message="暂无设备配对记录" />
          ) : controlPlaneDeviceInvites.map((invite) => {
            const status = formatDeviceInviteStatus(invite);
            return (
              <div className="settings-invite-item" key={invite.id}>
                <div className="settings-node-main">
                  <strong>{invite.name || invite.id}</strong>
                  <span>{invite.deviceId || invite.controlEndpoint || invite.id}</span>
                </div>
                <div className="settings-node-meta">
                  <Tag color={status.color}>{status.label}</Tag>
                  {invite.scopes.map((scope) => <Tag key={scope}>{scope.replace(':read', '')}</Tag>)}
                  <Tag>过期 {formatTimestamp(invite.expiresAt)}</Tag>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>添加 Control Plane</h2>
            <p>手机/PWA 先探测 descriptor，确认服务身份和能力后再保存 profile。</p>
          </div>
        </div>
        <Form
          form={controlPlaneForm}
          layout="vertical"
          onFinish={handleSaveControlPlane}
          initialValues={{
            endpoint: getDefaultControlEndpoint(),
            name: '当前 Control Plane'
          }}
        >
          <Form.Item
            name="endpoint"
            label="Control Plane URL"
            help="支持 HTTPS、Tailscale/ZeroTier/WireGuard IP、Cloudflare Tunnel 或局域网地址。"
            rules={[{ required: true, message: '请输入 Control Plane URL' }]}
          >
            <Input placeholder="https://aih.example.com" />
          </Form.Item>

          <Form.Item name="name" label="显示名称">
            <Input placeholder="Home AIH" />
          </Form.Item>

          <Form.Item
            name="deviceToken"
            label="Device Token"
            help="可选；保存后用于读取该 Control Plane 下的设备 profile 和节点摘要。"
          >
            <Input.Password autoComplete="new-password" placeholder="配对后的一次性返回 token" />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<LinkOutlined />} loading={controlPlaneSaving}>
              探测并保存
            </Button>
          </Form.Item>
        </Form>
      </section>

      <section className="settings-panel">
        <div className="settings-panel-head">
          <div>
            <h2>已保存 Control Plane</h2>
            <p>这是手机多 server 管理的本地 profile；业务请求使用当前选中的 Control Plane。</p>
          </div>
        </div>
        <div className="settings-control-plane-list">
          {controlPlaneProfiles.length === 0 ? (
            <Alert type="info" showIcon message="暂无 Control Plane profile" />
          ) : controlPlaneProfiles.map((profile) => {
            const active = activeControlPlaneId === profile.id;
            return (
              <div
                className={`settings-control-plane-item${active ? ' settings-control-plane-item--active' : ''}`}
                key={profile.id}
              >
                <div className="settings-node-main">
                  <strong>{profile.name || profile.endpoint}</strong>
                  <span>{profile.endpoint}</span>
                  {profile.lastError && <span className="settings-control-plane-error">{profile.lastError}</span>}
                </div>
                {renderControlPlaneSummary(profile)}
                <Space size={6} className="settings-control-plane-actions">
                  {active && <Tag color="green">当前</Tag>}
                  <Button
                    size="small"
                    disabled={active}
                    onClick={() => handleSelectControlPlane(profile.id)}
                  >
                    设为当前
                  </Button>
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    loading={checkingControlPlaneId === profile.id}
                    onClick={() => handleRefreshControlPlane(profile)}
                  >
                    {profile.deviceToken ? '同步' : '探测'}
                  </Button>
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => handleRemoveControlPlane(profile.id)}
                  >
                    移除
                  </Button>
                </Space>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );

  return (
    <div className="settings-page animate__animated animate__fadeIn animate__faster">
      <PageHero
        title="设置"
        eyebrow="配置"
        description="管理 server、额度刷新和模型别名。"
      />
      <Tabs
        className="settings-tabs"
        defaultActiveKey={getInitialSettingsTab()}
        items={[
          {
            key: 'basic',
            label: '基础设置',
            forceRender: true,
            children: basicSettingsContent,
          },
          {
            key: 'aliases',
            label: '模型别名',
            children: (
              <section className="settings-panel settings-panel--aliases">
                <ModelAliases />
              </section>
            ),
          },
          {
            key: 'control-planes',
            label: '控制面',
            forceRender: true,
            children: controlPlanesContent,
          },
          {
            key: 'nodes',
            label: '远程节点',
            forceRender: true,
            children: remoteNodesContent,
          },
          {
            key: 'ssh-hosts',
            label: 'SSH 开发机',
            children: (
              <section className="settings-panel settings-panel--ssh-hosts">
                <SshHostsPanel />
              </section>
            ),
          },
        ]}
      />
    </div>
  );
};

export default Settings;
