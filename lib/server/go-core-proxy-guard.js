'use strict';

// Go 的出站连接池克隆自 http.DefaultTransport，因此只认标准代理环境变量
// （http.ProxyFromEnvironment 读 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 及其小写形式）。
//
// server config 的 proxy_url（--proxy-url / AIH_SERVER_PROXY_URL / 持久化配置）Go 自己读不到；
// Node 用显式 undici ProxyAgent，不依赖这些变量。为了让两边走同一个出口，Node 启动 Go
// 子进程时把自己生效的显式代理写进 Go 的标准变量（buildGoProxyEnvironment）。
// 推理路由全部归 Go，请求归属不再按代理一致性判定；两边不一致只可能出现在
// Go 重启前的窗口，请求仍由 Go 承接。

// Go 的 httpproxy 按大小写两组变量读取；这里与之对齐。
const STANDARD_PROXY_ENV = Object.freeze(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']);
const STANDARD_NO_PROXY_ENV = Object.freeze(['NO_PROXY', 'no_proxy']);
// Go 本身不读 ALL_PROXY，但它拉起的子进程（provider CLI）可能读；与标准变量保持一致。
const ALL_PROXY_ENV = Object.freeze(['ALL_PROXY', 'all_proxy']);
// 显式代理（server config / AIH_SERVER_PROXY_URL）交给 Go 时打上这个标记：
// Go 只在**环境变量来源**的代理连不上时回退直连（与 Node 的 shouldRetryWithoutProxy
// 同一语义），显式代理必须失败关闭，否则就是静默换出口 IP。
const PROXY_STRICT_ENV = 'AIH_SERVER_PROXY_STRICT';

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

// Node 生效的出口代理能否原样交给 Go。http(s) 与 socks5/socks5h 都行：
// Go 的 http.Transport 原生处理 socks5/socks5h 代理（dialConn 里的 socksNewDialer），
// 因此不需要在 Go 侧另做隧道 —— 两边能走同一个出口，判定的意义才成立。
//
// 注意 Go 把 `socks5` 与 `socks5h` 当同一件事（一律把域名交给代理解析，见
// net/http/transport.go 的注释），而 Node/curl 的 `socks5` 是本地解析。这个差异只影响
// 解析位置，不影响「是否经过该出口」，因此不构成出口分叉，不触发交还。
const GO_PROXY_SCHEMES = Object.freeze(['http:', 'https:', 'socks5:', 'socks5h:']);

function isGoUsableProxyUrl(value) {
  try {
    return GO_PROXY_SCHEMES.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Go 子进程的代理环境覆盖项：值为 null 表示从 Go 的环境里删除该变量。
 *
 * 与 Node 的生效规则（http-utils-utils resolveProxyConfig）一致：显式代理（server config /
 * AIH_SERVER_PROXY_URL）优先，http(s) 与 socks5/socks5h 都能交给 Go（见 isGoUsableProxyUrl）；
 * 其余 scheme Node 直连，Go 也必须直连。绕过表按 config → AIH_SERVER_NO_PROXY → NO_PROXY
 * 取第一个非空值。没有显式代理时不覆盖：Node 与 Go 读的是同一份宿主环境。
 *
 * @param {{proxyUrl?: string, noProxy?: string, env?: object}} input
 * @returns {Record<string, string|null>}
 */
function buildGoProxyEnvironment(input = {}) {
  const env = input.env || {};
  const explicitProxy = firstNonEmpty([input.proxyUrl, env.AIH_SERVER_PROXY_URL]);
  if (!explicitProxy) return {};
  const proxyUrl = isGoUsableProxyUrl(explicitProxy) ? explicitProxy : '';
  const noProxy = proxyUrl
    ? firstNonEmpty([input.noProxy, env.AIH_SERVER_NO_PROXY, ...STANDARD_NO_PROXY_ENV.map((name) => env[name])])
    : '';
  const overrides = {};
  for (const name of [...STANDARD_PROXY_ENV, ...ALL_PROXY_ENV]) overrides[name] = proxyUrl || null;
  for (const name of STANDARD_NO_PROXY_ENV) overrides[name] = noProxy || null;
  // 只有真的把显式代理交给 Go 时才锁定；没有显式代理时清掉，避免宿主环境
  // 里残留的标记把「环境代理回退直连」也一起关掉。
  overrides[PROXY_STRICT_ENV] = proxyUrl ? '1' : null;
  return overrides;
}

module.exports = {
  PROXY_STRICT_ENV,
  buildGoProxyEnvironment
};
