'use strict';

// P1：Go 的出站连接池克隆自 http.DefaultTransport，因此只认标准代理环境变量
// （http.ProxyFromEnvironment 读 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 及其小写形式）。
//
// server config 的 proxy_url（--proxy-url / AIH_SERVER_PROXY_URL / 持久化配置）Go 完全看不见：
// 那些请求会绕过代理直连出去——在只允许代理出网的环境里静默失败，在受限网络里泄漏真实出口 IP。
// Node 自己用显式 undici ProxyAgent，不依赖这些环境变量，所以两边会分叉。
//
// 在 P2 补齐 config 代理与按账号出口之前，这类配置下一律交还 Node（失败关闭）。
// 只有当生效的代理恰好来自 Go 也能读到的标准变量、且绕过表也一致时，才继续交给 Go。

// Go 的 httpproxy 按大小写两组变量读取；这里与之对齐。
const STANDARD_PROXY_ENV = Object.freeze(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']);
const STANDARD_NO_PROXY_ENV = Object.freeze(['NO_PROXY', 'no_proxy']);

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

/**
 * 判定当前出站代理配置是否超出 Go 的能力，超出一律交还 Node。
 *
 * @param {{proxyUrl?: string, noProxy?: string, env?: object}} input
 *   proxyUrl/noProxy 是 Node 实际生效的配置（来自 args / 持久化 config）；
 *   env 是 Go 子进程会继承的环境（即宿主进程环境）。
 * @returns {{defer: boolean, reason: string}}
 */
function explainGoProxyHandoff(input = {}) {
  const env = input.env || {};
  const effectiveProxy = nonEmpty(input.proxyUrl);
  // 没配代理时 Node 与 Go 都直连，不构成分叉。
  if (!effectiveProxy) return { defer: false, reason: '' };

  // Go 只能从子进程环境读到标准变量。Node 生效的代理若不是同一个标准变量，
  // Go 要么直连、要么走另一个代理——两种都是静默分叉。
  const standardProxy = firstNonEmpty(STANDARD_PROXY_ENV.map((name) => env[name]));
  if (standardProxy !== effectiveProxy) {
    return { defer: true, reason: 'proxy_not_go_visible' };
  }

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

module.exports = { explainGoProxyHandoff };
