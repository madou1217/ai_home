'use strict';

// WebUI 数据面：会话框「大段粘贴自动转文本附件」的阈值。
//
// 唯一持久化位置是 server config 的 largePasteChars（aih server config set
// --large-paste-chars <n> 写的是同一个键）。GET/POST 都固定走 Go：
// Go 在立即事务里只合并 largePasteChars，其它设置与密钥原样保留。

const { proxyGo } = require('./webui-go-proxy');
const { readRequestBody } = require('./http-utils');

const ROUTE = '/v0/webui/chat/paste-settings';
// Go 侧校验失败（400）与内部错误（500）原样回给浏览器，其余收敛成 503。
const PASTHROUGH_STATUSES = [400, 500];
const MESSAGE_READ = 'Go Core 未就绪，粘贴设置不可读';
const MESSAGE_WRITE = 'Go Core 未就绪，粘贴设置不可写';

function matchChatPasteRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  return pathname === ROUTE && (verb === 'GET' || verb === 'POST');
}

async function readPasteBody(ctx) {
  try {
    const buffer = await readRequestBody(ctx.req, { maxBytes: 4 * 1024 });
    const body = buffer && buffer.length ? JSON.parse(buffer.toString('utf8')) : {};
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch (_error) {
    return null;
  }
}

async function handleChatPasteRequest(ctx) {
  const method = String(ctx.req.method || '').toUpperCase();

  if (method === 'GET') {
    return proxyGo(ctx, {
      method: 'getChatPasteSettings',
      message: MESSAGE_READ,
      passStatuses: PASTHROUGH_STATUSES
    });
  }

  const body = await readPasteBody(ctx);
  if (!body) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_json' });
    return true;
  }
  return proxyGo(ctx, {
    method: 'updateChatPasteSettings',
    args: [body],
    message: MESSAGE_WRITE,
    passStatuses: PASTHROUGH_STATUSES
  });
}

module.exports = {
  handleChatPasteRequest,
  matchChatPasteRoute
};
