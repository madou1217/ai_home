'use strict';

// WebUI 项目目录树路由统一反代至 Go Core workspace/fs/tree（零 Node 回落）：
//   GET /v0/webui/fs/tree → GET /v1/management/webui/workspace/fs/tree

const { proxyWebuiGo } = require('./webui-go-proxy');

const FS_TREE_PASS_STATUSES = Object.freeze([400, 403, 404, 409, 500]);

function readQueryString(ctx) {
  if (ctx && ctx.url && ctx.url.searchParams) {
    return ctx.url.searchParams.toString();
  }
  const rawUrl = String((ctx && ctx.req && ctx.req.url) || '');
  const qIndex = rawUrl.indexOf('?');
  return qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
}

async function handleFileTreeRequest(ctx) {
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: '/v1/management/webui/workspace/fs/tree',
    query: readQueryString(ctx),
    passStatuses: FS_TREE_PASS_STATUSES,
    message: 'Go Core 未就绪，无法读取项目目录树'
  });
}

module.exports = { handleFileTreeRequest };
