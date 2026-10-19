'use strict';

// 账号出口的同步进程边界适配器：CLI / Desktop 构造 env 与 Chromium 参数时，按已提交的
// 绑定直接得到外部 HTTP(S) 代理，或在 TUN 模式下明确不走代理。绑定存在但解析失败时
// 抛错，保证不会继承宿主代理或静默直连。

const nodeFs = require('node:fs');
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
const CHROMIUM_PROXY_FLAG_PREFIXES = Object.freeze(['--proxy-server=', '--proxy-bypass-list=', '--no-proxy-server']);

function accountEgressError(code, cause, reason = '') {
  const detail = String(reason || '').trim();
  const error = new Error(detail ? `${code} (${detail})` : code, cause ? { cause } : undefined);
  error.code = code;
  if (detail) error.reason = detail;
  return error;
}

// 解析器依赖工具箱的系统代理/TUN 探测；按需加载，避免运行时层在初始化阶段拉起它们。
function egressResolver() {
  return require('../server/zcode-egress-resolver');
}

function stripProxyEnv(envObj) {
  const env = { ...(envObj || {}) };
  PROXY_ENV_KEYS.forEach((key) => delete env[key]);
  return env;
}

/**
 * 把异步编排层预解析的出口统一成 { bound, direct?, proxyUrl }。
 * egress.direct=true 表示 TUN 模式：客户端直连，由外部 TUN 接管。
 *
 * provider 决定 scheme 白名单（ZCode 原生 httpProxy 只收 HTTP(S)，见
 * provider 描述符的 egress.proxySchemes，经 zcode-egress-resolver 查询）：这里是**同步**边界，
 * 解析出的地址会直接写进 CLI 环境变量，收窄必须与保存时一致，否则会出现
 * 「保存时通过、启动时抛错」的分裂。
 */
function normalizeResolvedEgress(egress, provider = '') {
  if (!egress) return { bound: false, proxyUrl: '' };
  if (egress.ok !== true) {
    throw accountEgressError(String(egress.error || 'account_egress_unavailable'));
  }
  if (egress.direct === true) return { bound: true, direct: true, proxyUrl: '' };
  const proxyUrl = egressResolver().normalizeProxyUrl(egress.proxyServer, { provider });
  if (!proxyUrl) throw accountEgressError('account_egress_endpoint_invalid');
  return { bound: true, proxyUrl };
}

function resolveAccountEgressRuntimeProxy(options = {}) {
  const provider = String(options.provider || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(options, 'accountEgress')) {
    return normalizeResolvedEgress(options.accountEgress, provider);
  }

  const fsImpl = options.fs || nodeFs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const accountRef = String(options.accountRef || '').trim();
  if (!aiHomeDir || !accountRef) return { bound: false, proxyUrl: '' };

  let binding;
  try {
    binding = readAccountEgressBinding(fsImpl, aiHomeDir, accountRef);
  } catch (error) {
    throw accountEgressError('account_egress_binding_read_failed', error);
  }
  if (!binding) return { bound: false, proxyUrl: '' };

  const resolved = egressResolver().resolveEgressTarget({
    binding,
    provider,
    accountRef,
    // pool 绑定在 CLI 进程里没有进程内池，要靠它读 server 的运行文件（见 egress-pool-state-file）。
    aiHomeDir,
    fs: fsImpl,
    processObj: options.processObj || process,
    ...(options.platform ? { platform: options.platform } : {})
  });
  if (!resolved.ok) throw accountEgressError(resolved.error, undefined, resolved.reason);
  return resolved.target.kind === 'direct'
    ? { bound: true, direct: true, proxyUrl: '' }
    : { bound: true, proxyUrl: resolved.target.proxyUrl };
}

function applyAccountEgressProxyEnv(envObj, provider, options = {}) {
  const accountRef = String(options.accountRef || '').trim();
  if (!accountRef) return { ...(envObj || {}) };

  const env = stripProxyEnv(envObj);
  // ZCode 的模型、MCP、命令工具和内置浏览器统一消费账号原生 setting.json；
  // 额外注入通用代理变量会形成两套真相源，必须保持为空。
  if (String(provider || '').trim().toLowerCase() === 'zcode') return env;

  const egress = resolveAccountEgressRuntimeProxy({ ...options, provider });
  if (!egress.bound || egress.direct) return env;
  env.HTTP_PROXY = egress.proxyUrl;
  env.HTTPS_PROXY = egress.proxyUrl;
  env.ALL_PROXY = egress.proxyUrl;
  env.NO_PROXY = ACCOUNT_EGRESS_NO_PROXY;
  env.http_proxy = egress.proxyUrl;
  env.https_proxy = egress.proxyUrl;
  env.all_proxy = egress.proxyUrl;
  env.no_proxy = ACCOUNT_EGRESS_NO_PROXY;
  return env;
}

function decorateAccountEgressChromiumPlan(plan, provider, egress) {
  const normalizedPlan = {
    ...(plan || {}),
    args: (Array.isArray(plan?.args) ? plan.args : []).filter((arg) => (
      !CHROMIUM_PROXY_FLAG_PREFIXES.some((prefix) => String(arg).startsWith(prefix))
    ))
  };
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (normalizedProvider === 'zcode' || !egress) {
    return normalizedPlan;
  }
  // Chromium 的 --proxy-server 原生支持 socks5://（含远端 DNS 的 socks5h 语义），
  // 因此 socks 出口在桌面端不需要额外转换。
  const resolved = normalizeResolvedEgress(egress, normalizedProvider);
  if (resolved.direct) {
    // TUN 模式：不让 Chromium 再跟随系统代理，流量交给外部 TUN。
    normalizedPlan.args.push('--no-proxy-server');
    return normalizedPlan;
  }
  normalizedPlan.args.push(
    `--proxy-server=${resolved.proxyUrl}`,
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
  resolveAccountEgressRuntimeProxy,
  stripProxyEnv
};
