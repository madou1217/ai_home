'use strict';

// WebUI 数据面：会话框「大段粘贴自动转文本附件」的阈值。
//
// 唯一持久化位置是 server config 的 largePasteChars（aih server config set
// --large-paste-chars <n> 写的是同一个键）。GET/POST 都固定走 Go：
// Go 在立即事务里只合并 largePasteChars，其它设置与密钥原样保留。

const { readRequestBody } = require('./http-utils');

const ROUTE = '/v0/webui/chat/paste-settings';

function matchChatPasteRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  return pathname === ROUTE && (verb === 'GET' || verb === 'POST');
}

function writeProxyFailure(ctx, response, message) {
  const status = Number(response && response.status) || 0;
  if ((status === 400 || status === 500) && response && response.data) {
    ctx.writeJson(ctx.res, status, response.data);
    return;
  }
  ctx.writeJson(ctx.res, 503, {
    ok: false,
    error: String((response && response.data && response.data.error) || (response && response.errorCode) || 'go_core_unavailable'),
    message
  });
}

async function handleChatPasteRequest(ctx) {
  const method = String(ctx.req.method || '').toUpperCase();
  const goHost = ctx.deps && ctx.deps.goCoreSync;
  if (!goHost) {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，粘贴设置不可用' });
    return true;
  }

  let response = null;
  if (method === 'GET') {
    if (typeof goHost.getChatPasteSettings !== 'function') {
      ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，粘贴设置不可读' });
      return true;
    }
    try {
      response = await goHost.getChatPasteSettings();
    } catch (_error) {
      response = null;
    }
  } else {
    let body = null;
    try {
      const buffer = await readRequestBody(ctx.req, { maxBytes: 4 * 1024 });
      body = buffer && buffer.length ? JSON.parse(buffer.toString('utf8')) : {};
    } catch (_error) {
      ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
    if (typeof goHost.updateChatPasteSettings !== 'function') {
      ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，粘贴设置不可写' });
      return true;
    }
    try {
      response = await goHost.updateChatPasteSettings(body);
    } catch (_error) {
      response = null;
    }
  }

  if (response && response.ok === true && response.data) {
    ctx.writeJson(ctx.res, 200, response.data);
    return true;
  }
  writeProxyFailure(ctx, response, method === 'GET' ? 'Go Core 未就绪，粘贴设置不可读' : 'Go Core 未就绪，粘贴设置不可写');
  return true;
}

module.exports = {
  handleChatPasteRequest,
  matchChatPasteRoute
};
