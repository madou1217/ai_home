'use strict';

// kimi-code-cli 客户端版本的**动态解析与缓存**。
//
// 为什么不能硬编码：`X-Msh-Version` / `User-Agent` 里自报的版本是上游识别客户端代际的
// 依据。写死一个值（此前是 '0.36.0'）有两个后果：
//   ① 本机 CLI 升级后，网关仍自报旧版本 —— 上游若按版本下发能力或限流策略，行为会漂移；
//   ② 反过来，上游对过旧客户端可能直接拒绝。
//
// 三级解析（先本地、再远端、最后兜底），结果带 TTL 缓存：
//   ① 本地 CLI 实测版本（`kimi --version`）—— 最权威，反映这台机器真实在用的客户端；
//   ② npm registry 上的最新发布版 —— **不要求本机装了 CLI**：CLI 未安装时也能跟进新版，
//      避免"没装客户端就永远自报老版本"；
//   ③ 代码内兜底常量 —— 离线、registry 不可达时的最后一档。
//
// 与 codex 的 codex-client-version.js 同构（探测 + TTL 缓存 + 版本比较），差别只在多了
// 远端一档：kimi 的客户端分发渠道是 npm，registry 可查。

const { execFileSync } = require('node:child_process');

// KIMI_CODE_VERSION_FALLBACK 是离线兜底版本。
//
// 取值的含义：它只在「本地没装 CLI」且「registry 查不到」时使用。刻意取一个**中性偏新**
// 的值 —— 自报过旧会被上游按旧客户端对待，而版本号本身不参与鉴权（与家族的 UA 同理）。
const KIMI_CODE_VERSION_FALLBACK = '0.36.0';

// NPM_REGISTRY_URL 是版本查询端点。可用 AIH_NPM_REGISTRY_URL 覆盖（企业内网镜像）。
const DEFAULT_NPM_REGISTRY_URL = 'https://registry.npmjs.org';

// CACHE_TTL_MS：本地版本一小时重探（CLI 会自动更新）；远端版本一天一查
// （发版频率远低于探测频率，没必要每次启动都打 registry）。
const LOCAL_CACHE_TTL_MS = 60 * 60 * 1000;
const REMOTE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const KIMI_CLI_PACKAGE = '@moonshot-ai/kimi-code';

let localCache = { version: '', at: 0 };
let remoteCache = { version: '', at: 0 };

/** 从任意文本里抽出三段式版本号（`kimi-code-cli 0.36.0` → `0.36.0`）。 */
function parseKimiClientVersion(value) {
  const match = String(value || '').match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

/** 三段式版本比较：左小返回 -1，相等 0，左大 1。 */
function compareKimiClientVersions(left, right) {
  const a = String(left || '').split('.').map((part) => Number(part) || 0);
  const b = String(right || '').split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) < (b[index] || 0) ? -1 : 1;
  }
  return 0;
}

/**
 * 探测本机 kimi CLI 的版本。
 *
 * 探测失败（没装、超时、输出认不出）返回空串 —— 调用方据此走下一档，不抛错：
 * 「这台机器没装 CLI」是正常情况，不是错误。
 */
function detectLocalKimiClientVersion(options = {}) {
  const processObj = options.processObj || process;
  const env = processObj.env || {};
  const explicit = parseKimiClientVersion(options.kimiClientVersion);
  if (explicit) return explicit;

  const command = String(options.kimiCommand || env.AIH_KIMI_BIN || 'kimi').trim() || 'kimi';
  try {
    const exec = options.execFileSync || execFileSync;
    const raw = exec(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: Math.max(250, Number(options.timeoutMs) || 1000),
      env,
      windowsHide: true
    });
    return parseKimiClientVersion(raw);
  } catch (_error) {
    return '';
  }
}

/**
 * 查询 npm registry 上的最新发布版本。
 *
 * **不要求本机装了 CLI** —— 这正是这一档存在的理由：没装客户端也能跟进上游新版，
 * 而不是永远自报代码里的兜底常量。
 *
 * 任何失败（网络、超时、形状不符）都返回空串，让调用方走下一档。
 * 该函数是异步的，调用方需 await；同步路径用 getKimiClientVersionSync。
 */
async function fetchLatestKimiClientVersion(options = {}) {
  // 显式传入 fetchImpl（含 null）时不回落到全局 fetch：调用方需要能声明「本路径不联网」，
  // 否则测试与离线环境会意外发起真实请求。
  const fetchImpl = Object.hasOwn(options, 'fetchImpl') ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return '';
  const registry = String(
    options.registryUrl
    || (options.processObj || process).env?.AIH_NPM_REGISTRY_URL
    || DEFAULT_NPM_REGISTRY_URL
  ).replace(/\/+$/, '');
  const url = `${registry}/${encodeURIComponent(KIMI_CLI_PACKAGE).replace('%40', '@')}/latest`;
  try {
    const response = await fetchImpl(url, {
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(Math.max(1000, Number(options.timeoutMs) || 3000))
        : undefined
    });
    if (!response || !response.ok) return '';
    const payload = await response.json();
    return parseKimiClientVersion(payload && payload.version);
  } catch (_error) {
    return '';
  }
}

/**
 * 解析当前应自报的 kimi 客户端版本（同步路径）。
 *
 * 顺序：本地实测 → 已缓存的远端版本 → 兜底常量。
 *
 * 远端那一档是异步的（见 refreshKimiClientVersion），本函数只**读缓存**，不发起网络
 * 请求 —— 请求路径不能被网络阻塞。调用方（服务启动、定时任务）负责调用刷新。
 */
function getKimiClientVersionSync(options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  if (!localCache.version || now - localCache.at >= LOCAL_CACHE_TTL_MS) {
    localCache = { version: detectLocalKimiClientVersion(options), at: now };
  }
  if (localCache.version) return localCache.version;
  if (remoteCache.version && now - remoteCache.at < REMOTE_CACHE_TTL_MS) return remoteCache.version;
  return KIMI_CODE_VERSION_FALLBACK;
}

/**
 * 刷新远端版本缓存（异步）。
 *
 * 返回刷新后的版本号；查询失败时保留原缓存（不把「这次网络抖动」当成「上游没有新版」）。
 */
async function refreshKimiClientVersion(options = {}) {
  const version = await fetchLatestKimiClientVersion(options);
  if (!version) return remoteCache.version;
  remoteCache = { version, at: typeof options.now === 'function' ? options.now() : Date.now() };
  return version;
}

/**
 * 解析当前应自报的版本（异步，含远端查询）。
 *
 * 与 getKimiClientVersionSync 的差别：本函数在本地没装 CLI 时**主动**查一次 registry。
 * 用于服务启动、定时刷新这类可以等待网络的路径。
 */
async function resolveKimiClientVersion(options = {}) {
  const local = detectLocalKimiClientVersion(options);
  if (local) return local;
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  if (!remoteCache.version || now - remoteCache.at >= REMOTE_CACHE_TTL_MS) {
    await refreshKimiClientVersion(options);
  }
  return remoteCache.version || KIMI_CODE_VERSION_FALLBACK;
}

/** 清空缓存（测试用）。 */
function resetKimiClientVersionCacheForTest() {
  localCache = { version: '', at: 0 };
  remoteCache = { version: '', at: 0 };
}

module.exports = {
  DEFAULT_NPM_REGISTRY_URL,
  KIMI_CLI_PACKAGE,
  KIMI_CODE_VERSION_FALLBACK,
  LOCAL_CACHE_TTL_MS,
  REMOTE_CACHE_TTL_MS,
  compareKimiClientVersions,
  detectLocalKimiClientVersion,
  fetchLatestKimiClientVersion,
  getKimiClientVersionSync,
  parseKimiClientVersion,
  refreshKimiClientVersion,
  resetKimiClientVersionCacheForTest,
  resolveKimiClientVersion
};
