'use strict';

const {
  listControlPlaneProfiles,
  saveControlPlaneProfile
} = require('./control-plane-profile-store');

/* WebUI server 代理（R1）：客户端是薄壳，连到哪个 server 就完整用哪个。
 * 浏览器始终只跟本地 /v0/webui/* 说话（同源、免 CORS、过 R2 门），
 * 若请求头 x-aih-server-id 指向另一台已配置 server，则本地 server 把整条请求
 * 转发到该 server 的 /v0/webui/*（server→server 无需 CORS），原样返回。
 * 这样所有现有完整页面无需改动即可跟随当前 server（等价 workspace 迁到另一台电脑）。 */

const TARGET_HEADER = 'x-aih-server-id';
const MANAGEMENT_KEY_ROTATION_PATH = '/v0/webui/server-config/management-key/rotate';

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

/** 解析目标 server：按 profileId 从共享存储查 endpoint + Management Key。返回 null 表示本地处理。 */
function resolveProxyTarget({ req, requestHost, deps }) {
  let serverId = String((req.headers && req.headers[TARGET_HEADER]) || '').trim();
  // EventSource/WebSocket 带不了自定义头，改由 query 参数 x-aih-server-id 指定目标 server。
  if (!serverId && req.url && req.url.indexOf(`${TARGET_HEADER}=`) >= 0) {
    try {
      serverId = String(new URL(req.url, 'http://localhost').searchParams.get(TARGET_HEADER) || '').trim();
    } catch (_error) {
      serverId = '';
    }
  }
  if (!serverId) return null;
  const profiles = listControlPlaneProfiles({ fs: deps.fs, aiHomeDir: deps.aiHomeDir });
  const list = Array.isArray(profiles) ? profiles : (profiles && profiles.profiles) || [];
  const profile = list.find((entry) => entry && entry.id === serverId);
  if (!profile || !profile.endpoint) return null;
  const targetOrigin = normalizeOrigin(profile.endpoint);
  const selfOrigin = normalizeOrigin(`http://${requestHost || '127.0.0.1'}`);
  if (!targetOrigin || targetOrigin === selfOrigin) return null; // 指向本机 → 本地处理
  return {
    profileId: profile.id,
    endpoint: profile.endpoint.replace(/\/+$/, ''),
    managementKey: String(profile.managementKey || ''),
    profile
  };
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

function syncRotatedProxyCredential({ target, body, deps }) {
  let payload;
  try {
    payload = body ? JSON.parse(body.toString('utf8')) : null;
  } catch (_error) {
    payload = null;
  }
  const managementKey = String(payload && payload.managementKey || '').trim();
  if (!managementKey || !target || !target.profile) {
    throw new Error('invalid_proxy_management_key_rotation_payload');
  }
  saveControlPlaneProfile({
    ...target.profile,
    managementKey,
    updatedAt: Date.now()
  }, {}, {
    fs: deps.fs,
    aiHomeDir: deps.aiHomeDir
  });
}

/** 把请求转发到目标 server 的同路径 /v0/webui/*，原样回传。
 * 关键：SSE / 流式响应(text/event-stream)必须**边收边转**，不能 arrayBuffer() 缓冲整包——
 * 否则远端终端、聊天增量、工具调用等所有流式都会被卡成"永远连接中/不出字"。 */
async function proxyWebUiRequest({ req, res, url, target, deps }) {
  const fetchImpl = deps.fetchImpl || fetch;
  const targetUrl = `${target.endpoint}${url.pathname}${url.search || ''}`;
  // 转发客户端的 accept：EventSource / 聊天流带 text/event-stream，上游据此返回 SSE。
  const clientAccept = String((req.headers && req.headers.accept) || '').trim();
  const headers = { accept: clientAccept || 'application/json' };
  const contentType = req.headers && req.headers['content-type'];
  if (contentType) headers['content-type'] = contentType;
  if (target.managementKey) headers.authorization = `Bearer ${target.managementKey}`;
  const body = await readRawBody(req);

  const isIdempotent = req.method === 'GET' || req.method === 'HEAD';
  const maxAttempts = isIdempotent ? 3 : 1;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let upstream;
  let lastError;
  let boundOnClose = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (res.writableEnded) return;
    const ctrl = new AbortController();
    const onClose = () => { try { ctrl.abort(); } catch (_e) {} };
    res.on('close', onClose);
    // 只对「建连」设超时：headers 到手后清掉，让流式 body 长活；客户端断开则 abort。
    const connectTimer = setTimeout(onClose, 30000);
    try {
      upstream = await fetchImpl(targetUrl, {
        method: req.method,
        headers,
        body: body || undefined,
        signal: ctrl.signal,
        // undici：流式响应需要 half-duplex/长连接，禁用自动解压以保持字节保真。
        duplex: body ? 'half' : undefined
      });
      clearTimeout(connectTimer);
      boundOnClose = onClose; // 成功这次的 onClose 保留，用于在客户端断开时中止上游流。
      lastError = null;
      break;
    } catch (error) {
      clearTimeout(connectTimer);
      res.off('close', onClose);
      lastError = error;
      if (attempt < maxAttempts) await sleep(250 * attempt);
    }
  }
  if (lastError || !upstream) {
    if (!res.writableEnded) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: 'server_proxy_upstream_failed',
        message: String((lastError && lastError.message) || lastError || 'fetch failed'),
        retryable: true
      }));
    }
    return;
  }

  const upstreamContentType = upstream.headers.get('content-type') || '';
  const isStream = upstreamContentType.includes('text/event-stream');

  if (isStream && upstream.body && typeof upstream.body.getReader === 'function') {
    // 流式：边收边写，不缓冲。
    res.writeHead(upstream.status, {
      'content-type': upstreamContentType || 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || res.writableEnded) break;
        if (value && value.length) res.write(Buffer.from(value));
      }
    } catch (_error) {
      // 客户端断开或上游结束。
    } finally {
      if (boundOnClose) res.off('close', boundOnClose);
      try { if (!res.writableEnded) res.end(); } catch (_e) {}
    }
    return;
  }

  // 非流式：缓冲整包回传（保留原有行为 + 重试语义）。
  const buf = Buffer.from(await upstream.arrayBuffer());
  if (boundOnClose) res.off('close', boundOnClose);
  if (res.writableEnded) return;
  const isManagementKeyRotation = req.method === 'POST'
    && url.pathname === MANAGEMENT_KEY_ROTATION_PATH;
  if (isManagementKeyRotation && upstream.ok) {
    try {
      syncRotatedProxyCredential({ target, body, deps });
    } catch (_error) {
      res.writeHead(502, {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify({
        ok: false,
        error: 'server_proxy_credential_sync_failed',
        message: '远程 Server 已轮换 Management Key，但本地代理凭据保存失败。'
      }));
      return;
    }
  }
  res.writeHead(upstream.status, {
    'content-type': upstreamContentType || 'application/json',
    ...(isManagementKeyRotation ? { 'cache-control': 'no-store' } : {})
  });
  res.end(buf);
}

module.exports = {
  TARGET_HEADER,
  MANAGEMENT_KEY_ROTATION_PATH,
  resolveProxyTarget,
  proxyWebUiRequest,
  syncRotatedProxyCredential
};
