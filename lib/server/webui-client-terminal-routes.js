'use strict';

// 客户端终端发现、安装计划/执行、拉起与作业 SSE 路由 ——
// 全部业务逻辑、作业状态机与 SSE 流已迁至 Go Core（零回落）；
// Node 仅在 /open 前按客户端来路解析 terminal transport（native vs webui）。

const { proxyWebuiGo } = require('./webui-go-proxy');
const { resolveTerminalTransport } = require('./webui-terminal-transport-policy');
const {
  buildRouteCtx,
  pipeWebuiSseStream,
  readJsonBody
} = require('./webui-managed-tool-routes');

const TERMINAL_PASS_STATUSES = [400, 404, 405, 409, 413, 428, 500];

function isMatchedTerminalPath(pathname) {
  return pathname === '/v0/webui/terminals'
    || pathname === '/v0/webui/toolkit/terminals'
    || pathname === '/v0/webui/toolkit/terminals/plan'
    || pathname === '/v0/webui/toolkit/terminals/execute'
    || pathname === '/v0/webui/toolkit/terminals/open'
    || pathname.startsWith('/v0/webui/toolkit/terminals/jobs/');
}

async function handleWebUiClientTerminalRoutes(req, res, method, pathname, ctx = {}) {
  if (!isMatchedTerminalPath(pathname)) return false;
  const routeCtx = buildRouteCtx(ctx, req, res, method, pathname);

  if (method === 'GET' && pathname === '/v0/webui/terminals') {
    return proxyWebuiGo(routeCtx, {
      method: 'GET',
      path: '/v1/management/webui/terminals',
      passStatuses: TERMINAL_PASS_STATUSES,
      message: 'Go Core 未就绪，无法读取终端列表'
    });
  }
  if (method === 'GET' && pathname === '/v0/webui/toolkit/terminals') {
    return proxyWebuiGo(routeCtx, {
      method: 'GET',
      path: '/v1/management/webui/toolkit/terminals',
      passStatuses: TERMINAL_PASS_STATUSES,
      message: 'Go Core 未就绪，无法读取终端列表'
    });
  }

  if (method !== 'POST') {
    const jobMatch = pathname.match(/^\/v0\/webui\/toolkit\/terminals\/jobs\/([^/]+)(?:\/(watch))?$/);
    if (method === 'GET' && jobMatch) {
      let jobId = '';
      try {
        jobId = decodeURIComponent(jobMatch[1]);
      } catch (_error) {
        routeCtx.writeJson(routeCtx.res, 400, { ok: false, error: 'invalid_job_path' });
        return true;
      }
      const goJobPath = `/v1/management/webui/toolkit/terminals/jobs/${encodeURIComponent(jobId)}`;
      if (jobMatch[2] === 'watch') {
        return pipeWebuiSseStream(routeCtx, `${goJobPath}/watch`, 'Go Core 未就绪，终端安装任务事件流不可用');
      }
      return proxyWebuiGo(routeCtx, {
        method: 'GET',
        path: goJobPath,
        passStatuses: TERMINAL_PASS_STATUSES,
        message: 'Go Core 未就绪，无法读取终端安装任务'
      });
    }
    routeCtx.writeJson(routeCtx.res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  const body = await readJsonBody(routeCtx, {
    invalidCode: 'invalid_terminal_payload',
    invalidMessage: '终端请求参数无效。'
  });
  if (body === null) return true;

  if (pathname === '/v0/webui/toolkit/terminals/plan') {
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: '/v1/management/webui/toolkit/terminals/plan',
      body,
      passStatuses: TERMINAL_PASS_STATUSES,
      message: 'Go Core 未就绪，无法生成终端操作计划'
    });
  }

  if (pathname === '/v0/webui/toolkit/terminals/open') {
    const deps = routeCtx.deps || {};
    const transport = resolveTerminalTransport({
      req: routeCtx.req,
      requested: body.transport,
      processObj: routeCtx.processObj || deps.processObj || process,
      env: routeCtx.env || deps.env
    });
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: '/v1/management/webui/toolkit/terminals/open',
      body: { ...body, transport },
      passStatuses: TERMINAL_PASS_STATUSES,
      message: 'Go Core 未就绪，无法打开客户端终端'
    });
  }

  if (pathname === '/v0/webui/toolkit/terminals/execute') {
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: '/v1/management/webui/toolkit/terminals/execute',
      body,
      status: 202,
      passStatuses: TERMINAL_PASS_STATUSES,
      message: 'Go Core 未就绪，无法创建终端操作任务'
    });
  }

  routeCtx.writeJson(routeCtx.res, 404, { ok: false, error: 'terminal_route_not_found' });
  return true;
}

module.exports = {
  handleWebUiClientTerminalRoutes
};
