'use strict';

// Go 的出站连接池克隆自 http.DefaultTransport，因此只认标准代理环境变量
// （http.ProxyFromEnvironment 读 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 及其小写形式）。
//
// server config 的 proxy_url（--proxy-url / AIH_SERVER_PROXY_URL / 持久化配置）Go 自己读不到；
// Node 用显式 undici ProxyAgent，不依赖这些变量。为了让两边走同一个出口，Node 启动 Go
// 子进程时把自己生效的显式代理写进 Go 的标准变量（buildGoProxyEnvironment）。
// 转发前判定（explainGoProxyHandoff）再拿 Node 当前生效的代理和 Go 实际收到的环境比对，
// 仍不一致（例如运行中改了配置、Go 尚未重启）就交还 Node，失败关闭。

// Go 的 httpproxy 按大小写两组变量读取；这里与之对齐。
const STANDARD_PROXY_ENV = Object.freeze(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']);
const STANDARD_NO_PROXY_ENV = Object.freeze(['NO_PROXY', 'no_proxy']);
// Go 本身不读 ALL_PROXY，但它拉起的子进程（provider CLI）可能读；与标准变量保持一致。
const ALL_PROXY_ENV = Object.freeze(['ALL_PROXY', 'all_proxy']);

function nonEmpty(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function firstNonEmpty(values) {
  for (const value of values) {
    const text = nonEmpty(value);
    if (text) return text;
  }
  return '';
}

function isHttpProxyUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Go 子进程的代理环境覆盖项：值为 null 表示从 Go 的环境里删除该变量。
 *
 * 与 Node 的生效规则（http-utils-utils resolveProxyConfig）一致：显式代理（server config /
 * AIH_SERVER_PROXY_URL）优先且只接受 http(s)；显式代理不是 http(s) 时 Node 直连，Go 也必须
 * 直连。绕过表按 config → AIH_SERVER_NO_PROXY → NO_PROXY 取第一个非空值。没有显式代理时
 * 不覆盖：Node 与 Go 读的是同一份宿主环境。
 *
 * @param {{proxyUrl?: string, noProxy?: string, env?: object}} input
 * @returns {Record<string, string|null>}
 */
function buildGoProxyEnvironment(input = {}) {
  const env = input.env || {};
  const explicitProxy = firstNonEmpty([input.proxyUrl, env.AIH_SERVER_PROXY_URL]);
  if (!explicitProxy) return {};
  const proxyUrl = isHttpProxyUrl(explicitProxy) ? explicitProxy : '';
  const noProxy = proxyUrl
    ? firstNonEmpty([input.noProxy, env.AIH_SERVER_NO_PROXY, ...STANDARD_NO_PROXY_ENV.map((name) => env[name])])
    : '';
  const overrides = {};
  for (const name of [...STANDARD_PROXY_ENV, ...ALL_PROXY_ENV]) overrides[name] = proxyUrl || null;
  for (const name of STANDARD_NO_PROXY_ENV) overrides[name] = noProxy || null;
  return overrides;
}

/** 把覆盖项叠加到一份环境上（返回新对象，null 表示删除）。 */
function applyProxyEnvironment(env, overrides) {
  const result = { ...(env || {}) };
  for (const [name, value] of Object.entries(overrides || {})) {
    if (value === null || value === undefined || value === '') delete result[name];
    else result[name] = String(value);
  }
  return result;
}

/**
 * 判定 Go 是否会和 Node 走同一个出站代理；不一致一律交还 Node。
 *
 * @param {{proxyUrl?: string, noProxy?: string, env?: object}} input
 *   proxyUrl/noProxy 是 Node 实际生效的配置（来自 args / 持久化 config）；
 *   env 是 Go 子进程实际收到的环境（宿主环境叠加 buildGoProxyEnvironment）。
 * @returns {{defer: boolean, reason: string}}
 */
function explainGoProxyHandoff(input = {}) {
  const env = input.env || {};
  const explicitProxy = nonEmpty(input.proxyUrl);
  // 没有显式代理时 Node 与 Go 读同一份宿主环境，不构成分叉。
  if (!explicitProxy) return { defer: false, reason: '' };

  // Node 只接受 http(s) 显式代理，其余 scheme 直连；此时 Go 也不能带代理。
  // Go 只能从子进程环境读到标准变量；两边不是同一个代理时 Go 要么直连、要么
  // 走另一个代理——两种都是静默分叉。
  const effectiveProxy = isHttpProxyUrl(explicitProxy) ? explicitProxy : '';
  const standardProxy = firstNonEmpty(STANDARD_PROXY_ENV.map((name) => env[name]));
  if (standardProxy !== effectiveProxy) {
    return { defer: true, reason: 'proxy_not_go_visible' };
  }
  if (!effectiveProxy) return { defer: false, reason: '' };

  // 代理一致时，绕过表也必须一致，否则 Go 会对不同的 host 直连。
  const effectiveNoProxy = nonEmpty(input.noProxy);
  if (effectiveNoProxy) {
    const standardNoProxy = firstNonEmpty(STANDARD_NO_PROXY_ENV.map((name) => env[name]));
    if (effectiveNoProxy !== standardNoProxy) {
      return { defer: true, reason: 'proxy_not_go_visible' };
    }
  }
  return { defer: false, reason: '' };
}

module.exports = {
  applyProxyEnvironment,
  buildGoProxyEnvironment,
  explainGoProxyHandoff
};
