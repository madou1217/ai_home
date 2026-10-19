'use strict';

// 当前网络守卫：账号**不走出口池**时（未绑定 / 系统代理 / 外部 TUN / 自定义地址），
// 它实际出网的位置是否被该账号的上游拒绝 —— 例如 claude 官方上游严格拒绝中国大陆，
// 本机直连在大陆时**坚决不让**账号用，并提示用户设置出口或开启本地代理。
//
// 判定与出口池共用一套（egress-region-policy 的 evaluateExit）：用户规则 > 实测 > 预置提示。
// 位置来自 egress-geo（经同一出口查询出口 IP 归属），按「出口」缓存：
//   - 进程内缓存 + 运行文件 `<aiHome>/run/egress-network-geo.json`（server 与 CLI 共用，0600）；
//   - 网关（异步）：冷缓存时最多等一次查询，过期时先用旧值、后台刷新；
//   - CLI / 桌面启动（同步边界）：缓存缺失或过期时用子进程同步查询一次（有超时）。
// 查不到位置 = 未知 = 放行（不能因为查询服务不可达就把所有账号拦下）。走出口池的账号不经这里。

const nodeChildProcess = require('node:child_process');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { EGRESS_LOCAL_GEO_TTL_MS } = require('../cli/config/constants');
const { describeGeo, lookupExitGeo } = require('./egress-geo');

const CACHE_FILE = 'egress-network-geo.json';
const SYNC_LOOKUP_TIMEOUT_MS = 9000;
const ASYNC_COLD_WAIT_MS = 4000;
const MAX_CACHE_ENTRIES = 32;

const memory = new Map();
const inflight = new Map();

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cacheFilePath(aiHomeDir, pathImpl = nodePath) {
  return pathImpl.join(String(aiHomeDir || ''), 'run', CACHE_FILE);
}

/** 出口键：direct 或代理地址（去掉凭据，凭据不进缓存文件）。 */
function exitKeyOf(proxyUrl) {
  const raw = normalizeString(proxyUrl);
  if (!raw) return 'direct';
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}:${url.port}`;
  } catch (_error) {
    return 'direct';
  }
}

function readCacheFile(fs, aiHomeDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(cacheFilePath(aiHomeDir), 'utf8'));
    return doc && typeof doc.entries === 'object' ? doc.entries : {};
  } catch (_error) {
    return {};
  }
}

function writeCacheEntry(fs, aiHomeDir, key, entry) {
  memory.set(key, entry);
  if (!aiHomeDir) return;
  try {
    const entries = { ...readCacheFile(fs, aiHomeDir), [key]: entry };
    const keys = Object.keys(entries).sort((a, b) => entries[b].at - entries[a].at).slice(0, MAX_CACHE_ENTRIES);
    const file = cacheFilePath(aiHomeDir);
    fs.mkdirSync(nodePath.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ entries: Object.fromEntries(keys.map((item) => [item, entries[item]])) }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (_error) {
    /* 缓存写失败只影响下次要不要重查 */
  }
}

function readCached(fs, aiHomeDir, key) {
  const fromMemory = memory.get(key);
  const fromFile = aiHomeDir ? readCacheFile(fs, aiHomeDir)[key] : null;
  const best = [fromMemory, fromFile].filter((entry) => entry && entry.geo).sort((a, b) => b.at - a.at)[0];
  return best || null;
}

function proxiedFetch(proxyUrl) {
  if (!proxyUrl) return fetch;
  return (url, init) => {
    // 与网关同一个代理调度器（http(s) / socks5 都支持，见 http-utils-utils.getProxyDispatcher）。
    // eslint-disable-next-line global-require
    const { getProxyDispatcher } = require('../server/http-utils-utils');
    const dispatcher = getProxyDispatcher(proxyUrl);
    if (!dispatcher) return Promise.reject(new Error('proxy_dispatcher_unavailable'));
    return fetch(url, { ...init, dispatcher });
  };
}

/** 异步查询（网关用）：同一出口并发只查一次。 */
function refreshExitGeo(options = {}) {
  const fs = options.fs || nodeFs;
  const key = exitKeyOf(options.proxyUrl);
  if (inflight.has(key)) return inflight.get(key);
  const task = lookupExitGeo({ fetch: options.fetch || proxiedFetch(options.proxyUrl) })
    .then((result) => {
      if (result && result.ok) {
        const entry = { geo: result.geo, at: Date.now(), source: result.source };
        writeCacheEntry(fs, options.aiHomeDir, key, entry);
        return entry;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => { inflight.delete(key); });
  inflight.set(key, task);
  return task;
}

/** 网关：拿出口位置。冷缓存时最多等 ASYNC_COLD_WAIT_MS；过期时用旧值并后台刷新。 */
async function getExitGeo(options = {}) {
  const fs = options.fs || nodeFs;
  const key = exitKeyOf(options.proxyUrl);
  const ttl = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : EGRESS_LOCAL_GEO_TTL_MS;
  const cached = readCached(fs, options.aiHomeDir, key);
  if (cached && cached.at + ttl > Date.now()) return cached;
  const pending = refreshExitGeo(options);
  if (cached) return cached;
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Number(options.coldWaitMs) || ASYNC_COLD_WAIT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([pending, timeout]);
}

/** CLI / 桌面启动（同步边界）：缓存缺失或过期时子进程同步查一次。 */
function getExitGeoSync(options = {}) {
  const fs = options.fs || nodeFs;
  const key = exitKeyOf(options.proxyUrl);
  const ttl = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : EGRESS_LOCAL_GEO_TTL_MS;
  const cached = readCached(fs, options.aiHomeDir, key);
  if (cached && cached.at + ttl > Date.now()) return cached;
  const execFileSync = options.execFileSync || nodeChildProcess.execFileSync;
  try {
    const script = `const g=require(${JSON.stringify(__filename)});`
      + 'g.refreshExitGeo({proxyUrl:process.argv[1]||"",aiHomeDir:process.argv[2]||""})'
      + '.then(e=>{process.stdout.write(JSON.stringify(e||null));process.exit(0)});';
    const out = execFileSync(process.execPath, ['-e', script, normalizeString(options.proxyUrl), normalizeString(options.aiHomeDir)], {
      timeout: Number(options.timeoutMs) || SYNC_LOOKUP_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    });
    const entry = JSON.parse(String(out || 'null'));
    if (entry && entry.geo) {
      memory.set(key, entry);
      return entry;
    }
  } catch (_error) {
    /* 查不到 = 未知 */
  }
  return cached || null;
}

/**
 * 判定：exit = { proxyUrl } 的位置对 upstream 是否被拒。
 * context = { rules, hints, evidence, ttlMs }（egress-pool-planner.upstreamContext 同形）。
 * @returns {{ status, source, detail, geo, geoText, exitKey } | null}  null = 该上游没有任何地区规则 / 提示
 */
function evaluateNetworkExit(context, geoEntry) {
  if (!context) return null;
  const rules = (context.policy && context.policy.rules) || context.rules || [];
  const hints = context.hints || [];
  if (rules.length === 0 && hints.length === 0) return null;
  // eslint-disable-next-line global-require
  const { evaluateExit, ipExitKey } = require('../server/egress-region-policy');
  const geo = geoEntry && geoEntry.geo ? geoEntry.geo : null;
  const exitKey = geo && geo.ip ? ipExitKey(geo.ip) : '';
  const verdict = geo
    ? evaluateExit({ exit: { identity: '', geo }, rules, hints, evidence: context.evidence, exitKey, evidenceTtlMs: context.ttlMs })
    : { status: 'unknown', source: 'none', detail: '出口位置未知' };
  return { ...verdict, geo, geoText: describeGeo(geo), exitKey };
}

/** 给用户看的拒绝说明（CLI 输出 / 网关错误详情 / WebUI 共用）。 */
function describeNetworkDenial(verdict, upstreamId) {
  const where = verdict && verdict.geoText ? verdict.geoText : '当前出口';
  return `${upstreamId || '该上游'} 不接受来自 ${where} 的请求（${verdict && verdict.detail || '地区受限'}）。`
    + '请为该账号设置出口（WebUI 账号 → 出口：出口池 / 代理地址），或开启本地代理 / TUN 后重试。';
}

function resetEgressNetworkGuardCacheForTests() {
  memory.clear();
  inflight.clear();
}

module.exports = {
  CACHE_FILE,
  describeNetworkDenial,
  evaluateNetworkExit,
  exitKeyOf,
  getExitGeo,
  getExitGeoSync,
  refreshExitGeo,
  resetEgressNetworkGuardCacheForTests
};
