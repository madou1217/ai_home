'use strict';

const {
  readJsonValue,
  writeJsonValue
} = require('./app-state-store');
const {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  normalizeServerPort
} = require('./server-defaults');

const DEFAULT_SERVER_CONFIG = {
  host: DEFAULT_SERVER_HOST,
  port: DEFAULT_SERVER_PORT,
  apiKey: '',
  managementKey: '',
  openNetwork: false,
  proxyUrl: '',
  noProxy: '',
  modelsProbeAccounts: 2,
  // 窗口激活的全局 opt-in（逐账号开关之外的第二道闸门，同 AIH_SERVER_WINDOW_ACTIVATION）。
  // 默认关：每次探测都是一次真实上游请求，只有显式打开（且逐账号开启）才生效。
  windowActivation: false,
  // 全局默认间隔（4h）与下限（1h）：逐账号弹窗「留空」时用的就是这两个值，
  // 也是调度器夹取的下限 —— 与 args.js 的 AIH_SERVER_WINDOW_ACTIVATION_* 同义。
  windowActivationDefaultIntervalMs: 60 * 60 * 1000,
  windowActivationMinIntervalMs: 60 * 60 * 1000,
  goCoreEnabled: false,
  goCoreRoutes: [],
  upstreamErrorRuleProviders: [],
  // 中转 UDP 前端（`--relay-udp` / `--relay-udp-advertise-host` / `--relay-udp-advertise-port` 的持久化形态）。
  // 'default' = 跟随环境/默认（起）；'on' / 'off' = 显式覆盖（config 优先于环境变量）。
  relayUdp: 'default',
  relayUdpAdvertiseHost: '',
  relayUdpAdvertisePort: 0,
  // 中转端口布局（`--relay-port-mode`）：server = 跟随 AIH 端口（默认），dedicated = 每节点一个端口。
  relayPortMode: 'default',
  // 中转边车/入口绑定网卡（`--relay-listen-host`）；空 = 默认（本地 127.0.0.1 / 远端 0.0.0.0）。
  relayListenHost: '',
  // 路由尝试次数上限（原 AIH_SERVER_MAX_ATTEMPTS）。0 = 默认（3）。
  maxAttempts: 0
};
const SERVER_CONFIG_KEY = 'config:server';

// route-ownership manifest 条目 ID 列表；合法性由 Server 启动时对照 manifest 校验。
function normalizeGoCoreRoutes(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
}

// Go Core 承接哪些 Provider 的账号自定义错误规则（`AIH_SERVER_UPSTREAM_ERROR_RULES` 的持久化形态）。
// Go 侧对空项与重复项是硬错误（能力声明写错会让 Go 拒绝启动），因此在唯一写入门就归一化：
// 小写化、丢弃空白项、去重。空数组表示 Go 不承接任何账号，Node 继续自己执行全部规则。
function normalizeUpstreamErrorRuleProviders(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(items.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))];
}

function sanitizeServerConfig(input = {}) {
  const requestedHost = String(
    input.host === undefined || input.host === null
      ? DEFAULT_SERVER_CONFIG.host
      : input.host
  ).trim();
  const host = requestedHost && requestedHost !== '0.0.0.0'
    ? requestedHost
    : DEFAULT_SERVER_CONFIG.host;
  const port = normalizeServerPort(input.port, DEFAULT_SERVER_CONFIG.port);
  const apiKey = String(input.apiKey === undefined || input.apiKey === null ? '' : input.apiKey).trim();
  const managementKey = String(
    input.managementKey === undefined || input.managementKey === null ? '' : input.managementKey
  ).trim();
  const openNetwork = Boolean(input.openNetwork) || requestedHost === '0.0.0.0';
  const proxyUrl = String(input.proxyUrl === undefined || input.proxyUrl === null ? '' : input.proxyUrl).trim();
  const noProxy = String(input.noProxy === undefined || input.noProxy === null ? '' : input.noProxy).trim();
  const modelsProbeAccounts = Math.max(1, Math.min(8, Number(input.modelsProbeAccounts) || 2));
  const windowActivation = input.windowActivation === true;
  const windowActivationMinIntervalMs = Math.max(
    60 * 1000,
    Number(input.windowActivationMinIntervalMs) || DEFAULT_SERVER_CONFIG.windowActivationMinIntervalMs
  );
  const windowActivationDefaultIntervalMs = Math.max(
    windowActivationMinIntervalMs,
    Number(input.windowActivationDefaultIntervalMs) || DEFAULT_SERVER_CONFIG.windowActivationDefaultIntervalMs
  );
  const goCoreEnabled = input.goCoreEnabled === true;
  const goCoreRoutes = normalizeGoCoreRoutes(input.goCoreRoutes);
  const upstreamErrorRuleProviders = normalizeUpstreamErrorRuleProviders(input.upstreamErrorRuleProviders);
  const relayUdpRaw = String(input.relayUdp === undefined || input.relayUdp === null ? 'default' : input.relayUdp).trim().toLowerCase();
  const relayUdp = ['on', 'off', 'default'].includes(relayUdpRaw) ? relayUdpRaw : 'default';
  const relayUdpAdvertiseHost = String(input.relayUdpAdvertiseHost === undefined || input.relayUdpAdvertiseHost === null ? '' : input.relayUdpAdvertiseHost).trim();
  const relayUdpAdvertisePort = Math.max(0, Math.min(65535, Number(input.relayUdpAdvertisePort) || 0));
  const maxAttempts = Math.max(0, Math.min(32, Number(input.maxAttempts) || 0));
  const relayPortModeRaw = String(input.relayPortMode === undefined || input.relayPortMode === null ? 'default' : input.relayPortMode).trim().toLowerCase();
  const relayPortMode = ['server', 'dedicated', 'default'].includes(relayPortModeRaw) ? relayPortModeRaw : 'default';
  const relayListenHost = String(input.relayListenHost === undefined || input.relayListenHost === null ? '' : input.relayListenHost).trim();
  return {
    host: openNetwork ? '0.0.0.0' : host,
    port,
    apiKey,
    managementKey,
    openNetwork,
    proxyUrl,
    noProxy,
    modelsProbeAccounts,
    windowActivation,
    windowActivationDefaultIntervalMs,
    windowActivationMinIntervalMs,
    goCoreEnabled,
    goCoreRoutes,
    upstreamErrorRuleProviders,
    relayUdp,
    relayUdpAdvertiseHost,
    relayUdpAdvertisePort,
    relayPortMode,
    relayListenHost,
    maxAttempts
  };
}

function readServerConfig(deps = {}) {
  const { fs, aiHomeDir } = deps;
  if (!fs || !String(aiHomeDir || '').trim()) return { ...DEFAULT_SERVER_CONFIG };
  const stored = readJsonValue(fs, aiHomeDir, SERVER_CONFIG_KEY);
  return stored && typeof stored === 'object'
    ? sanitizeServerConfig(stored)
    : { ...DEFAULT_SERVER_CONFIG };
}

function mergeServerConfigPatch(currentConfig, patch) {
  const base = sanitizeServerConfig(currentConfig);
  const next = { ...base };
  const input = patch && typeof patch === 'object' ? patch : {};

  for (const key of Object.keys(DEFAULT_SERVER_CONFIG)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (value === undefined || value === null) continue;
    next[key] = value;
  }

  if (
    Object.prototype.hasOwnProperty.call(input, 'openNetwork')
    && input.openNetwork === false
    && (input.host === undefined || input.host === null)
    && next.host === '0.0.0.0'
  ) {
    next.host = DEFAULT_SERVER_CONFIG.host;
  }

  return sanitizeServerConfig(next);
}

function writeServerConfig(config, deps = {}) {
  const { fs, aiHomeDir } = deps;
  if (!fs || !String(aiHomeDir || '').trim()) return { ...DEFAULT_SERVER_CONFIG };
  const normalized = mergeServerConfigPatch(readServerConfig(deps), config);
  if (!writeJsonValue(fs, aiHomeDir, SERVER_CONFIG_KEY, normalized)) {
    throw new Error('server_config_write_failed');
  }
  return normalized;
}

function buildServerArgsFromConfig(config = {}) {
  const normalized = sanitizeServerConfig(config);
  const args = [
    '--host', normalized.host,
    '--port', String(normalized.port)
  ];
  if (normalized.proxyUrl) args.push('--proxy-url', normalized.proxyUrl);
  if (normalized.noProxy) args.push('--no-proxy', normalized.noProxy);
  if (normalized.modelsProbeAccounts !== DEFAULT_SERVER_CONFIG.modelsProbeAccounts) {
    args.push('--models-probe-accounts', String(normalized.modelsProbeAccounts));
  }
  // 窗口激活的全局闸门必须随保存配置一起下发：`aih server restart` 只吃保存配置
  // （CLI 不接受 serve 参数），漏了这一行等于「配置存了、永远不生效」。
  if (normalized.windowActivation) args.push('--window-activation');
  if (normalized.windowActivationDefaultIntervalMs !== DEFAULT_SERVER_CONFIG.windowActivationDefaultIntervalMs) {
    args.push('--window-activation-default-interval-ms', String(normalized.windowActivationDefaultIntervalMs));
  }
  if (normalized.windowActivationMinIntervalMs !== DEFAULT_SERVER_CONFIG.windowActivationMinIntervalMs) {
    args.push('--window-activation-min-interval-ms', String(normalized.windowActivationMinIntervalMs));
  }
  return args;
}

module.exports = {
  DEFAULT_SERVER_CONFIG,
  SERVER_CONFIG_KEY,
  normalizeUpstreamErrorRuleProviders,
  sanitizeServerConfig,
  mergeServerConfigPatch,
  readServerConfig,
  writeServerConfig,
  buildServerArgsFromConfig
};
