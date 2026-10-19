'use strict';

// 把账号出口绑定解析成交给客户端的代理目标。url / system 模式直接使用外部代理，
// tun 模式交给外部 TUN（客户端直连），这三者 AIH 都不运行代理内核、不开本地端口；
// pool 模式例外：地址来自出口池在本机回环上开的出站端口（见 lib/runtime/egress-pool-*）。
// 这里只做读取、校验与探测结果缓存，不修改系统网络。

const {
  EGRESS_MODE_POOL,
  EGRESS_MODE_SYSTEM,
  EGRESS_MODE_TUN,
  EGRESS_MODE_URL
} = require('../account/zcode-egress-binding-store');
const { normalizeClientPlatform } = require('../runtime/client-platform');
const { detectSystemProxy } = require('../cli/services/toolkit/proxy-manager');
const { detectTun } = require('../cli/services/toolkit/system-network-manager');

const SUPPORTED_PLATFORM = 'macos';
// 出口地址允许的 scheme。socks5/socks5h 曾经被一刀切拒绝，理由只有一个：网关请求路径
// （undici ProxyAgent）只认 http(s)，socks 地址会被静默丢弃成**直连** —— 那是 fail-open，
// 必须堵。现在网关侧由 socks5-connector 提供真正的 SOCKS5 隧道（Agent 自定义 connect），
// 静默直连的成因消失，socks5 因此可以放行。
// 只收 socks5 / socks5h（socks4 无域名解析且已过时；`socks://` 语义在实现间不一致，不猜）。
// 带凭据的地址仍然拒绝：凭据会随绑定落盘并注入 CLI 环境变量，当前不支持。
const ALLOWED_PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);
// 各出口消费方能承载的 scheme —— 声明在 provider 描述符的 `egress` 能力里
// （lib/providers/defs/<id>.js，契约 lib/providers/contract.js 的 validateEgressCapability），
// 这里只经门面查询，不持有 provider 名单。消费方做不到的事在**入口**拒绝，而不是写进绑定后
// 由消费方静默降级。未声明 = 全集：
//
//   - 网关请求（Node）：undici + socks5-connector → http(s) / socks5 / socks5h
//   - Go Core：http.Transport 原生处理 socks5/socks5h → http(s) / socks5 / socks5h
//   - CLI 环境变量：socks 走 ALL_PROXY（curl / Go / 多数工具都读）→ http(s) / socks5 / socks5h
//   - 其它 provider 的桌面端：Chromium --proxy-server 原生支持 socks5 → http(s) / socks5 / socks5h
//
// 收窄的现有声明：zcode（原生 setting.json httpProxy）、opencode（Bun 静默忽略 socks env）。
const DEFAULT_EGRESS_PROXY_SCHEMES = Object.freeze(['http:', 'https:', 'socks5:', 'socks5h:']);
// 错误码沿用历史名（WebUI 文案表与既有测试按它映射）；文案本身是通用的「原生代理字段只支持 HTTP(S)」。
const ZCODE_NATIVE_SCHEME_ERROR = 'zcode_native_proxy_scheme_unsupported';
// 系统代理与 TUN 探测要起子进程（scutil / ifconfig / netstat / ps）。调用方显式要求时
// （网关请求热路径）按「探测函数 + 平台」复用短期结果；注入的探测函数各自独立缓存。
const DETECTION_CACHE_TTL_MS = 15 * 1000;
let detectionCache = new WeakMap();

function fail(error, extra = {}) {
  return { ok: false, source: '', target: null, error, ...extra };
}

/**
 * 某 provider 的出口消费方能承载哪些 scheme（provider 描述符 `egress.proxySchemes`）。
 * provider 缺省或未声明时按全集 —— 只有描述符明确收窄时才收窄。
 */
function allowedSchemesForProvider(provider) {
  const key = String(provider || '').trim().toLowerCase();
  if (!key) return DEFAULT_EGRESS_PROXY_SCHEMES;
  // 门面按需加载：描述符会拉起各 provider 的探针模块，避免解析器初始化时形成环。
  const egress = require('../providers').getProviderCapability(key, 'egress');
  return egress && Array.isArray(egress.proxySchemes) && egress.proxySchemes.length > 0
    ? egress.proxySchemes
    : DEFAULT_EGRESS_PROXY_SCHEMES;
}

/**
 * 代理地址的问题：'' 表示合法；否则返回错误码。
 * 允许 scheme://host:port 与 host:port 简写；不允许凭据、路径、查询串。
 *
 * @param {string} rawUrl
 * @param {{provider?: string}} [options] provider 决定消费方能承载的 scheme（ZCode 只收 HTTP(S)）
 */
function proxyUrlIssue(rawUrl, options = {}) {
  const value = String(rawUrl || '').trim();
  if (!value) return 'invalid_proxy_url';
  if (!value.includes('://') && !/^[^\s:/?#]+:\d{1,5}$/.test(value)) return 'invalid_proxy_url';
  let parsed;
  try {
    parsed = new URL(value.includes('://') ? value : `http://${value}`);
  } catch {
    return 'invalid_proxy_url';
  }
  if (!ALLOWED_PROXY_SCHEMES.has(parsed.protocol)) return 'proxy_scheme_unsupported';
  // 消费方承载不了（如 ZCode 原生 httpProxy 只认 HTTP(S)）：明确报错，不写进绑定。
  if (!allowedSchemesForProvider(options.provider).includes(parsed.protocol)) {
    return ZCODE_NATIVE_SCHEME_ERROR;
  }
  if (!parsed.hostname || parsed.port === '0' || parsed.username || parsed.password) return 'invalid_proxy_url';
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) return 'invalid_proxy_url';
  return '';
}

/** 归一化成完整的 scheme://host:port；不合法返回 ''。 */
function normalizeProxyUrl(rawUrl, options = {}) {
  if (proxyUrlIssue(rawUrl, options)) return '';
  const value = String(rawUrl).trim();
  const parsed = new URL(value.includes('://') ? value : `http://${value}`);
  return `${parsed.protocol}//${parsed.host}`;
}

function resolvePlatform(input) {
  const processObj = input.processObj || process;
  const rawPlatform = input.platform !== undefined ? input.platform : processObj.platform;
  return {
    platform: normalizeClientPlatform(rawPlatform),
    rawPlatform,
    processObj
  };
}

function detectWithCache(detector, context, input) {
  const run = () => detector({ processObj: context.processObj, platform: context.rawPlatform });
  if (input.useDetectionCache !== true) return run();
  const now = typeof input.now === 'function' ? Number(input.now()) : Date.now();
  let entries = detectionCache.get(detector);
  if (!entries) {
    entries = new Map();
    detectionCache.set(detector, entries);
  }
  const cacheKey = String(context.rawPlatform);
  const cached = entries.get(cacheKey);
  if (cached && now - cached.at < DETECTION_CACHE_TTL_MS) return cached.value;
  const value = run();
  entries.set(cacheKey, { at: now, value });
  return value;
}

function resolveSystemProxyTarget(input, context) {
  const detector = typeof input.detectSystemProxy === 'function' ? input.detectSystemProxy : detectSystemProxy;
  let status;
  try {
    status = detectWithCache(detector, context, input);
  } catch (error) {
    return fail('system_proxy_unavailable', {
      reason: String((error && error.message) || error || 'system_proxy_probe_failed')
    });
  }
  if (status?.enabled !== true) {
    return fail('system_proxy_unavailable', { probeStatus: String(status?.probeStatus || 'unknown') });
  }
  const provider = String(input.provider || '').trim().toLowerCase();
  // 优先级 HTTPS > HTTP > SOCKS5：前两者是系统里的常规配置，SOCKS 只在没有前两者时才用。
  // SOCKS 曾在这里被拒绝（system_proxy_http_unavailable），原因是网关侧消费不了 —— 现在
  // 消费方能力已声明化（provider 描述符 egress.proxySchemes），因此只按消费方过滤，
  // 系统里只配了 SOCKS 的用户不再被迫手工另开一个 HTTP 端口。
  const proxyUrl = [status.httpsProxy, status.httpProxy, status.socksProxy]
    .map((candidate) => normalizeProxyUrl(candidate, { provider }))
    .find(Boolean) || '';
  if (!proxyUrl) {
    return fail(status.socksProxy ? 'system_proxy_scheme_unavailable' : 'system_proxy_unavailable', {
      probeStatus: String(status.probeStatus || 'unknown')
    });
  }
  return { ok: true, source: EGRESS_MODE_SYSTEM, target: { kind: 'proxy-url', proxyUrl } };
}

function resolveTunTarget(input, context) {
  const detector = typeof input.detectTun === 'function' ? input.detectTun : detectTun;
  let tun;
  try {
    tun = detectWithCache(detector, context, input);
  } catch (error) {
    return fail('tun_state_unknown', {
      reason: String((error && error.message) || error || 'tun_probe_failed')
    });
  }
  const state = String(tun?.state || 'unknown').trim().toLowerCase();
  if (state !== 'active') {
    return fail(state === 'inactive' ? 'tun_inactive' : 'tun_state_unknown', { tun });
  }
  return { ok: true, source: EGRESS_MODE_TUN, target: { kind: 'direct' }, tun };
}

/**
 * 出口池目标：地址不来自绑定记录，而是从进程内单例读当前就绪的本地出站端口。
 * 这样池换节点/换端口都不需要重新绑定；池没就绪时 fail-closed（不回落到全局代理，
 * 否则用户以为走了池、实际走了别的出口）。
 */
function resolveEgressPoolTarget(input = {}) {
  const registry = input.egressPoolRegistry || require('../runtime/egress-pool-registry');
  // aiHomeDir 只在本进程没有池服务时（用户启动的 `aih <cli>`）用来读 server 的运行文件。
  // accountRef 选账号的车道（节点范围 / 地区判定按账号分，见 egress-pool-runtime 的车道）。
  const accountRef = String(input.accountRef || '').trim();
  const poolOptions = {
    ...(input.aiHomeDir ? { aiHomeDir: input.aiHomeDir, ...(input.fs ? { fs: input.fs } : {}) } : {}),
    ...(accountRef ? { accountRef } : {})
  };
  const proxyUrl = normalizeProxyUrl(registry.currentEgressPoolProxyUrl(poolOptions));
  if (!proxyUrl) {
    // 池只在有人绑定时才起：第一次解析到 `pool` 而池未就绪，就在后台拉起它（只在 server 进程里有效）。
    // 本次请求仍 fail-closed（不等待、不回落到别的出口）。
    if (typeof registry.ensureEgressPoolStarted === 'function') registry.ensureEgressPoolStarted();
    const reason = typeof registry.describeEgressPoolUnavailable === 'function'
      ? String(registry.describeEgressPoolUnavailable(poolOptions) || '')
      : '';
    return fail('egress_pool_not_ready', reason ? { reason } : {});
  }
  return { ok: true, source: EGRESS_MODE_POOL, target: { kind: 'proxy-url', proxyUrl } };
}

/**
 * 同步解析绑定 → { ok, source, target: {kind:'proxy-url', proxyUrl} | {kind:'direct'} }。
 * 失败一律返回错误码，由调用方 fail-closed（不回落到全局代理或直连）。
 *
 * input.provider 决定 url 模式的 scheme 白名单（ZCode 原生 httpProxy 只收 HTTP(S)，
 * 见 provider 描述符 egress.proxySchemes）；缺省按全集。
 */
function resolveEgressTarget(input = {}) {
  const binding = input.binding;
  if (!binding) return fail('not_bound');
  if (binding.retired) return fail('account_egress_mode_retired', { mode: binding.mode });
  const context = resolvePlatform(input);
  if (context.platform !== SUPPORTED_PLATFORM) {
    return fail('not_supported', { platform: context.platform });
  }
  const provider = String(input.provider || '').trim().toLowerCase();
  if (binding.mode === EGRESS_MODE_SYSTEM) return resolveSystemProxyTarget(input, context);
  if (binding.mode === EGRESS_MODE_TUN) return resolveTunTarget(input, context);
  if (binding.mode === EGRESS_MODE_POOL) return resolveEgressPoolTarget(input);
  if (binding.mode === EGRESS_MODE_URL) {
    const issue = proxyUrlIssue(binding.proxyUrl, { provider });
    if (issue) return fail(issue);
    return {
      ok: true,
      source: EGRESS_MODE_URL,
      target: { kind: 'proxy-url', proxyUrl: normalizeProxyUrl(binding.proxyUrl) }
    };
  }
  return fail('unknown_egress_mode');
}

function clearEgressDetectionCache() {
  detectionCache = new WeakMap();
}

module.exports = {
  ALLOWED_PROXY_SCHEMES,
  DETECTION_CACHE_TTL_MS,
  DEFAULT_EGRESS_PROXY_SCHEMES,
  SUPPORTED_PLATFORM,
  ZCODE_NATIVE_SCHEME_ERROR,
  allowedSchemesForProvider,
  clearEgressDetectionCache,
  normalizeProxyUrl,
  proxyUrlIssue,
  resolveEgressPoolTarget,
  resolveEgressTarget
};
