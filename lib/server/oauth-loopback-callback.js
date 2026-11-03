'use strict';

const http = require('node:http');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function compactError(error) {
  const code = normalizeString(error && error.code);
  const message = normalizeString(error && error.message) || normalizeString(error) || 'unknown_error';
  return code ? `${code}: ${message}` : message;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildCallbackHtml(title, message) {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#111827}',
    'main{max-width:520px;padding:28px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 12px 32px rgba(15,23,42,.08)}',
    'h1{font-size:20px;line-height:1.3;margin:0 0 10px}',
    'p{font-size:14px;line-height:1.7;margin:0;color:#4b5563}',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(message)}</p>`,
    '</main>',
    '</body>',
    '</html>'
  ].join('');
}

function parseRedirectUri(redirectUri) {
  const parsed = new URL(redirectUri);
  const host = normalizeString(parsed.hostname) || 'localhost';
  const port = Number.parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10);
  return {
    protocol: parsed.protocol,
    host,
    port,
    path: parsed.pathname || '/'
  };
}

function resolveLoopbackBindHosts(host) {
  const normalized = normalizeString(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost') return ['127.0.0.1', '::1'];
  return [host];
}

function hasOauthCallbackPayload(requestUrl) {
  return Boolean(
    requestUrl.searchParams.get('code')
    || requestUrl.searchParams.get('error')
    || requestUrl.searchParams.get('error_description')
  );
}

function buildCallbackUrl(req, fallbackOrigin) {
  const host = normalizeString(req.headers && req.headers.host);
  const origin = host ? `http://${host}` : fallbackOrigin;
  return new URL(req.url || '/', origin).toString();
}

function sendHtml(res, statusCode, title, message) {
  const body = buildCallbackHtml(title, message);
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

// 需求：为本机 WebUI OAuth 授权提供短生命周期 loopback callback 捕获，避免用户手工复制 callback URL。
function startOauthLoopbackCallbackServer(options = {}) {
  const {
    redirectUri,
    httpImpl = http,
    onCallback,
    onListening,
    onUnavailable
  } = options;

  const target = parseRedirectUri(redirectUri);
  const fallbackOrigin = `${target.protocol}//${target.host}:${target.port}`;
  const bindHosts = resolveLoopbackBindHosts(target.host);
  const servers = [];
  let pendingBinds = bindHosts.length;
  let listeningCount = 0;
  let lastListenError = null;
  let listeningNotified = false;
  let closed = false;

  const handleRequest = async (req, res) => {
    if (closed) {
      sendHtml(res, 410, '授权任务已结束', '当前 OAuth 授权任务已经结束，请回到 AI Home 重新发起授权。');
      return;
    }
    const requestUrl = new URL(req.url || '/', fallbackOrigin);
    if (req.method !== 'GET' || requestUrl.pathname !== target.path) {
      sendHtml(res, 404, '页面不存在', '这个本地地址只用于接收当前 OAuth 授权回调。');
      return;
    }
    if (!hasOauthCallbackPayload(requestUrl)) {
      sendHtml(res, 200, '本地授权回调已就绪', 'AI Home 正在等待浏览器授权结果。请从 AI Home 打开的授权链接继续完成登录。');
      return;
    }
    if (typeof onCallback !== 'function') {
      sendHtml(res, 500, '授权回调不可用', '本地回调服务没有可用的授权处理器，请回到 AI Home 手动提交回调地址。');
      return;
    }

    try {
      const result = await onCallback(buildCallbackUrl(req, fallbackOrigin));
      if (result && result.ok) {
        sendHtml(res, 200, '授权成功', 'AI Home 已收到授权结果，可以关闭这个页面并回到应用。');
        return;
      }
      const code = normalizeString(result && (result.code || result.error)) || 'callback_failed';
      sendHtml(res, 400, '授权未完成', `AI Home 无法完成本次授权：${code}。请回到应用查看详情，或手动提交回调地址。`);
    } catch (error) {
      sendHtml(res, 500, '授权回调异常', `本地回调处理失败：${compactError(error)}。请回到 AI Home 手动提交回调地址。`);
    }
  };

  function markBindFailed(error) {
    if (closed) return;
    lastListenError = error;
    pendingBinds -= 1;
    if (pendingBinds <= 0 && listeningCount === 0) {
      closed = true;
      if (typeof onUnavailable === 'function') onUnavailable(lastListenError);
    }
  }

  function markListening(server, bindHost) {
    if (closed) return;
    pendingBinds -= 1;
    listeningCount += 1;
    if (listeningNotified) return;
    listeningNotified = true;
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : target.port;
    if (typeof onListening === 'function') {
      onListening({
        host: target.host,
        bindHost,
        port,
        url: `${target.protocol}//${target.host}:${port}${target.path}`
      });
    }
  }

  bindHosts.forEach((bindHost) => {
    const server = httpImpl.createServer(handleRequest);
    servers.push(server);
    server.on('error', markBindFailed);
    server.listen(target.port, bindHost, () => markListening(server, bindHost));
  });

  return {
    close() {
      if (closed) return;
      closed = true;
      servers.forEach((server) => {
        try {
          server.close();
        } catch (_error) {
          // best effort shutdown
        }
      });
    }
  };
}

module.exports = {
  hasOauthCallbackPayload,
  startOauthLoopbackCallbackServer
};
