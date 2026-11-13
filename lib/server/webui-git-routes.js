'use strict';

// WebUI Git 只读路由统一反代至 Go Core workspace/git（零 Node git 子进程回落）：
//   GET /v0/webui/git/summary → GET /v1/management/webui/workspace/git/summary
//   GET /v0/webui/git/diff    → GET /v1/management/webui/workspace/git/diff

const { proxyWebuiGo } = require('./webui-go-proxy');

const GIT_PASS_STATUSES = Object.freeze([400, 403, 404, 409, 500]);

function readQueryString(ctx) {
  if (ctx && ctx.url && ctx.url.searchParams) {
    return ctx.url.searchParams.toString();
  }
  const rawUrl = String((ctx && ctx.req && ctx.req.url) || '');
  const qIndex = rawUrl.indexOf('?');
  return qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
}

async function handleGitSummaryRequest(ctx) {
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: '/v1/management/webui/workspace/git/summary',
    query: readQueryString(ctx),
    passStatuses: GIT_PASS_STATUSES,
    message: 'Go Core 未就绪，无法读取 Git 工作区状态'
  });
}

async function handleGitDiffRequest(ctx) {
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: '/v1/management/webui/workspace/git/diff',
    query: readQueryString(ctx),
    passStatuses: GIT_PASS_STATUSES,
    message: 'Go Core 未就绪，无法读取 Git 差异'
  });
}

module.exports = { handleGitSummaryRequest, handleGitDiffRequest };
