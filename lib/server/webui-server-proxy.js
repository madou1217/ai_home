'use strict';

const { listControlPlaneProfiles } = require('./control-plane-profile-store');

/* WebUI server 代理（R1）：客户端是薄壳，连到哪个 server 就完整用哪个。
 * 浏览器始终只跟本地 /v0/webui/* 说话（同源、免 CORS、过 R2 门），
 * 若请求头 x-aih-server-id 指向另一台已配对 server，则本地 server 把整条请求
 * 转发到该 server 的 /v0/webui/*（server→server 无需 CORS），原样返回。
 * 这样所有现有完整页面无需改动即可跟随当前 server（等价 workspace 迁到另一台电脑）。 */

const TARGET_HEADER = 'x-aih-server-id';

function normalizeOrigin(endpoint) {
  try {
    const url = new URL(String(endpoint || ''));
    const host = url.hostname.toLowerCase();
    const normHost = (host === 'localhost' || host === '::1' || host === '[::1]') ? '127.0.0.1' : host;
    return `${url.protocol}//${normHost}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  } catch (_error) {
    return '';
  }
}

/** 解析目标 server：按 profileId 从共享存储查 endpoint+token。返回 null 表示本地处理。 */
function resolveProxyTarget({ req, requestHost, deps }) {
  const serverId = String((req.headers && req.headers[TARGET_HEADER]) || '').trim();
  if (!serverId) return null;
  const profiles = listControlPlaneProfiles({ fs: deps.fs, aiHomeDir: deps.aiHomeDir });
  const list = Array.isArray(profiles) ? profiles : (profiles && profiles.profiles) || [];
  const profile = list.find((entry) => entry && entry.id === serverId);
  if (!profile || !profile.endpoint) return null;
  const targetOrigin = normalizeOrigin(profile.endpoint);
  const selfOrigin = normalizeOrigin(`http://${requestHost || '127.0.0.1'}`);
  if (!targetOrigin || targetOrigin === selfOrigin) return null; // 指向本机 → 本地处理
  return { endpoint: profile.endpoint.replace(/\/+$/, ''), deviceToken: String(profile.deviceToken || '') };
}

async function readRawBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  return await new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    req.on('error', () => resolve(null));
  });
}

/** 把请求转发到目标 server 的同路径 /v0/webui/*，原样回传。 */
async function proxyWebUiRequest({ req, res, url, target, deps }) {
  const fetchImpl = deps.fetchImpl || fetch;
  const targetUrl = `${target.endpoint}${url.pathname}${url.search || ''}`;
  const headers = { accept: 'application/json' };
  const contentType = req.headers && req.headers['content-type'];
  if (contentType) headers['content-type'] = contentType;
  if (target.deviceToken) headers.authorization = `Bearer ${target.deviceToken}`;
  const body = await readRawBody(req);

  let upstream;
  try {
    upstream = await fetchImpl(targetUrl, {
      method: req.method,
      headers,
      body: body || undefined,
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'server_proxy_upstream_failed', message: String((error && error.message) || error) }));
    return;
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  const outHeaders = { 'content-type': upstream.headers.get('content-type') || 'application/json' };
  res.writeHead(upstream.status, outHeaders);
  res.end(buf);
}

module.exports = {
  TARGET_HEADER,
  resolveProxyTarget,
  proxyWebUiRequest
};
