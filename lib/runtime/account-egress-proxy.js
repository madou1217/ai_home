'use strict';

// 账号出口的同步进程边界适配器。异步解析、节点调度和 sidecar 生命周期属于
// zcode-egress-service；CLI/Desktop 构造 env 时只读取已经提交的绑定与状态快照。
// 绑定存在但数据面不可验证时抛错，保证不会继承宿主代理或静默直连。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { readAccountEgressBinding } = require('../account/zcode-egress-binding-store');

const ACCOUNT_EGRESS_NO_PROXY = 'localhost,127.0.0.1,::1';
const ACCOUNT_EGRESS_CHROMIUM_BYPASS = 'localhost;127.0.0.1;[::1]';
const PROXY_ENV_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy'
]);

function accountEgressError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function normalizeLoopbackProxyServer(value) {
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(String(value || '').trim());
  if (!match) return '';
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? `127.0.0.1:${port}`
    : '';
}

function stripProxyEnv(envObj) {
  const env = { ...(envObj || {}) };
  PROXY_ENV_KEYS.forEach((key) => delete env[key]);
  return env;
}

function isProcessAlive(pid, processObj = process) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  if (Number(processObj && processObj.pid) === value) return true;
  const kill = typeof processObj?.kill === 'function'
    ? processObj.kill.bind(processObj)
    : process.kill.bind(process);
  try {
    kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readRuntimeStatus(fsImpl, pathImpl, aiHomeDir) {
  const statusPath = pathImpl.join(
    aiHomeDir,
    'run',
    'zcode-egress',
    'sing-box',
    'status.json'
  );
  try {
    return JSON.parse(fsImpl.readFileSync(statusPath, 'utf8'));
  } catch (error) {
    throw accountEgressError('account_egress_runtime_status_unavailable', error);
  }
}

function normalizeResolvedEgress(egress) {
  if (!egress) return { bound: false, proxyServer: '' };
  if (egress.ok !== true) {
    throw accountEgressError(String(egress.error || 'account_egress_runtime_unavailable'));
  }
  const proxyServer = normalizeLoopbackProxyServer(egress.proxyServer);
  if (!proxyServer) throw accountEgressError('account_egress_endpoint_invalid');
  return { bound: true, proxyServer };
}

function resolveAccountEgressRuntimeProxy(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'accountEgress')) {
    return normalizeResolvedEgress(options.accountEgress);
  }

  const fsImpl = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const accountRef = String(options.accountRef || '').trim();
  if (!aiHomeDir || !accountRef) return { bound: false, proxyServer: '' };

  let binding;
  try {
    binding = readAccountEgressBinding(fsImpl, aiHomeDir, accountRef);
  } catch (error) {
    throw accountEgressError('account_egress_binding_read_failed', error);
  }
  if (!binding) return { bound: false, proxyServer: '' };

  const status = readRuntimeStatus(fsImpl, pathImpl, aiHomeDir);
  if (status?.engine !== 'sing-box' || status.running !== true || status.dataPlaneReady !== true) {
    throw accountEgressError('account_egress_runtime_not_ready');
  }
  if (!isProcessAlive(status.pid, options.processObj || process)) {
    throw accountEgressError('account_egress_runtime_process_unavailable');
  }
  const account = (Array.isArray(status.accounts) ? status.accounts : [])
    .find((candidate) => String(candidate?.accountRef || '') === accountRef) || null;
  const proxyServer = account
    ? normalizeLoopbackProxyServer(`127.0.0.1:${Number(account.port)}`)
    : '';
  if (!proxyServer) throw accountEgressError('account_egress_account_endpoint_unavailable');
  return { bound: true, proxyServer };
}

function applyAccountEgressProxyEnv(envObj, provider, options = {}) {
  const accountRef = String(options.accountRef || '').trim();
  if (!accountRef) return { ...(envObj || {}) };

  const env = stripProxyEnv(envObj);
  // ZCode 的模型、MCP、命令工具和内置浏览器统一消费账号原生 setting.json；
  // 额外注入通用代理变量会形成两套真相源，必须保持为空。
  if (String(provider || '').trim().toLowerCase() === 'zcode') return env;

  const egress = resolveAccountEgressRuntimeProxy(options);
  if (!egress.bound) return env;
  const proxyUrl = `http://${egress.proxyServer}`;
  env.HTTP_PROXY = proxyUrl;
  env.HTTPS_PROXY = proxyUrl;
  env.ALL_PROXY = proxyUrl;
  env.NO_PROXY = ACCOUNT_EGRESS_NO_PROXY;
  env.http_proxy = proxyUrl;
  env.https_proxy = proxyUrl;
  env.all_proxy = proxyUrl;
  env.no_proxy = ACCOUNT_EGRESS_NO_PROXY;
  return env;
}

function decorateAccountEgressChromiumPlan(plan, provider, egress) {
  const normalizedPlan = {
    ...(plan || {}),
    args: (Array.isArray(plan?.args) ? plan.args : []).filter((arg) => (
      !String(arg).startsWith('--proxy-server=')
      && !String(arg).startsWith('--proxy-bypass-list=')
    ))
  };
  if (String(provider || '').trim().toLowerCase() === 'zcode' || !egress) {
    return normalizedPlan;
  }
  const proxyServer = normalizeLoopbackProxyServer(egress.proxyServer);
  if (egress.ok !== true || !proxyServer) {
    throw accountEgressError('account_egress_endpoint_invalid');
  }
  normalizedPlan.args.push(
    `--proxy-server=http://${proxyServer}`,
    `--proxy-bypass-list=${ACCOUNT_EGRESS_CHROMIUM_BYPASS}`
  );
  return normalizedPlan;
}

module.exports = {
  ACCOUNT_EGRESS_CHROMIUM_BYPASS,
  ACCOUNT_EGRESS_NO_PROXY,
  PROXY_ENV_KEYS,
  applyAccountEgressProxyEnv,
  decorateAccountEgressChromiumPlan,
  normalizeLoopbackProxyServer,
  resolveAccountEgressRuntimeProxy,
  stripProxyEnv
};
