'use strict';

/* WebUI server 代理（R1）：客户端是薄壳，连到哪个 server 就完整用哪个。
 * 控制面 profile 读写统一走 Go（/v1/management/webui/control-plane/profiles），
 * Node 仅做 HTTP/SSE 边收边转转发，不再直接读写 control-plane-profile-store。 */

const TARGET_HEADER = 'x-aih-server-id';
const MANAGEMENT_KEY_ROTATION_PATH = '/v0/webui/server-config/management-key/rotate';
const GO_PROFILES_PATH = '/v1/management/webui/control-plane/profiles';

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

/** 解析目标 server：从 Go 控制面 API 查 endpoint + Management Key。返回 null 表示本地处理。 */
async function resolveProxyTarget({ req, requestHost, deps = {} }) {
  let serverId = String((req.headers && req.headers[TARGET_HEADER]) || '').trim();
  if (!serverId && req.url && req.url.indexOf(`${TARGET_HEADER}=`) >= 0) {
    try {
      serverId = String(new URL(req.url, 'http://localhost').searchParams.get(TARGET_HEADER) || '').trim();
    } catch (_error) {
      serverId = '';
    }
  }
  if (!serverId) return null;

  const goHost = deps && deps.goCoreSync;
  if (!goHost || typeof goHost.webuiRequest !== 'function') {
    return {
      error: 'go_core_unavailable',
      statusCode: 503,
      profileId: serverId,
      message: 'Go Core 未就绪，无法解析目标 server'
    };
  }

  let res = null;
  try {
    res = await goHost.webuiRequest({ method: 'GET', path: GO_PROFILES_PATH });
  } catch (_error) {
    res = null;
  }
  if (!res || res.ok !== true || !res.data) {
    return {
      error: String((res && res.data && res.data.error) || (res && res.errorCode) || 'go_core_unavailable'),
      statusCode: Number(res && res.status) || 503,
      profileId: serverId
    };
  }

  const list = Array.isArray(res.data.profiles) ? res.data.profiles : [];
  const profile = list.find((entry) => entry && entry.id === serverId);
  if (!profile || !profile.endpoint) {
    return {
      error: 'server_proxy_profile_not_found',
      statusCode: 404,
      profileId: serverId
    };
  }
  const targetOrigin = normalizeOrigin(profile.endpoint);
  const selfOrigin = normalizeOrigin(`http://${requestHost || '127.0.0.1'}`);
  if (!targetOrigin || targetOrigin === selfOrigin) return null;
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

async function syncRotatedProxyCredential({ target, body, deps = {} }) {
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
  const goHost = deps && deps.goCoreSync;
  if (!goHost || typeof goHost.webuiRequest !== 'function') {
    throw new Error('go_core_unavailable');
  }
  const res = await goHost.webuiRequest({
    method: 'POST',
    path: GO_PROFILES_PATH,
    body: {
      profile: {
        ...target.profile,
        managementKey,
        updatedAt: Date.now()
      }
    }
  });
  if (!res || res.ok !== true) {
    throw new Error(String((res && res.data && res.data.error) || 'control_plane_profile_save_failed'));
  }
}

/** 把请求转发到目标 server 的同路径 /v0/webui/*，原样回传（SSE 边收边转）。 */
async function proxyWebUiRequest({ req, res, url, target, deps = {} }) {
  const fetchImpl = deps.fetchImpl || fetch;
  const targetUrl = `${target.endpoint}${url.pathname}${url.search || ''}`;
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
    const connectTimer = setTimeout(onClose, 30000);
    try {
      upstream = await fetchImpl(targetUrl, {
        method: req.method,
        headers,
        body: body || undefined,
        signal: ctrl.signal,
        duplex: body ? 'half' : undefined
      });
      clearTimeout(connectTimer);
      boundOnClose = onClose;
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

  const buf = Buffer.from(await upstream.arrayBuffer());
  if (boundOnClose) res.off('close', boundOnClose);
  if (res.writableEnded) return;
  const isManagementKeyRotation = req.method === 'POST'
    && url.pathname === MANAGEMENT_KEY_ROTATION_PATH;
  if (isManagementKeyRotation && upstream.ok) {
    try {
      await syncRotatedProxyCredential({ target, body, deps });
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
