'use strict';

const { getTransportKindMetadata, normalizeTransportKind } = require('./transport-registry');

const STRATEGY_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'no-public-ip-default',
    title: '无公网默认',
    priority: 10,
    defaultTransport: 'relay',
    dataPlaneTransports: ['relay'],
    bootstrapTransports: ['ssh'],
    underlayTransports: [],
    summary: '节点保持一条到 Server 的出站 Relay 连接；目标机器无需公网入口。',
    constraints: [
      'Server URL 必须是手机和目标机器都能访问的 LAN/Overlay/FRP/公网地址。',
      'SSH 只用于并行探测和部署；Relay 才是默认数据面。'
    ]
  }),
  Object.freeze({
    id: 'managed-overlay-data-plane',
    title: '自管 Overlay 数据面',
    priority: 20,
    defaultTransport: 'tailscale',
    dataPlaneTransports: ['tailscale', 'wireguard', 'zerotier'],
    bootstrapTransports: ['ssh'],
    underlayTransports: ['mptcp', 'omr'],
    summary: 'Tailscale/WireGuard/ZeroTier 暴露真实 HTTP endpoint；AIH 按节点 RPC 直连。',
    constraints: [
      'Overlay 只负责可达性；每个节点仍需要运行 AIH server。',
      'OMR/MPTCP 可改善底层路径，但不是独立 RPC 通道。'
    ]
  }),
  Object.freeze({
    id: 'frp-public-entry',
    title: 'FRP 入口',
    priority: 30,
    defaultTransport: 'frp',
    dataPlaneTransports: ['frp'],
    bootstrapTransports: ['ssh'],
    underlayTransports: ['mptcp', 'omr'],
    summary: '用户自管 FRP 暴露 AIH HTTP endpoint；AIH 记录 endpoint 并按数据面使用。',
    constraints: [
      'AIH 不安装和托管 FRP；只保存可访问的 HTTP/HTTPS endpoint。',
      '需要把 endpointHint 填成最终可访问地址。'
    ]
  }),
  Object.freeze({
    id: 'parallel-ssh-bootstrap',
    title: '多节点并行 SSH',
    priority: 40,
    defaultTransport: 'ssh',
    dataPlaneTransports: ['relay', 'frp', 'tailscale', 'wireguard', 'zerotier'],
    bootstrapTransports: ['ssh'],
    underlayTransports: [],
    summary: '对 Linux/macOS/可 SSH Windows 并行做只读探测和 bootstrap；写入前仍需要显式执行确认。',
    constraints: [
      'SSH 通道不等于最终数据面；部署完成后节点应注册 Relay 或真实 HTTP transport。',
      'Windows 密码必须走交互输入，不能写入命令、日志或配置。'
    ]
  }),
  Object.freeze({
    id: 'underlay-optimization',
    title: '链路聚合底座',
    priority: 60,
    defaultTransport: 'omr',
    dataPlaneTransports: [],
    bootstrapTransports: [],
    underlayTransports: ['omr', 'mptcp'],
    summary: 'OpenMPTCPRouter/MPTCP 只作为底层路径优化；上层仍选择 Relay、FRP 或 Overlay 承载 AIH RPC。',
    constraints: [
      'Underlay 不提供节点注册、鉴权或 RPC。',
      '不要把 OMR/MPTCP 当成无公网穿透方案本身。'
    ]
  })
]);

function normalizeKinds(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => normalizeTransportKind(value))
    .filter(Boolean);
}

function decorateStrategy(definition) {
  const defaultTransport = normalizeTransportKind(definition.defaultTransport);
  const metadata = getTransportKindMetadata(defaultTransport) || {};
  return {
    id: definition.id,
    title: definition.title,
    priority: definition.priority,
    defaultTransport,
    provider: metadata.provider || defaultTransport,
    lane: metadata.lane || '',
    endpointMode: metadata.endpointMode || '',
    dataPlaneTransports: normalizeKinds(definition.dataPlaneTransports),
    bootstrapTransports: normalizeKinds(definition.bootstrapTransports),
    underlayTransports: normalizeKinds(definition.underlayTransports),
    summary: definition.summary,
    constraints: Array.isArray(definition.constraints) ? definition.constraints.slice() : []
  };
}

function buildRemoteTransportStrategies() {
  return STRATEGY_DEFINITIONS
    .map(decorateStrategy)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

module.exports = {
  buildRemoteTransportStrategies
};
