'use strict';

const { getAppInstallJobManager } = require('./webui-app-install-routes');
const { getClientTerminalJobManager } = require('./webui-client-terminal-routes');
const { getWebUiTaskHub } = require('./webui-task-hub');

function writeJson(ctx, status, payload) {
  if (typeof ctx.writeJson === 'function') {
    ctx.writeJson(ctx.res, status, payload);
    return;
  }
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  ctx.res.end(JSON.stringify(payload));
}

function ensureTaskSources(ctx) {
  // Creating both managers here registers their active-job projections with
  // the shared hub, so a fresh page can hydrate without knowing task type.
  getAppInstallJobManager(ctx);
  getClientTerminalJobManager(ctx);
  return getWebUiTaskHub(ctx);
}

async function handleWebUiTaskRoutes(ctx = {}) {
  const { method, pathname, req, res } = ctx;
  if (pathname !== '/v0/webui/tasks' && pathname !== '/v0/webui/tasks/watch') return false;
  const hub = ensureTaskSources(ctx);
  if (method === 'GET' && pathname === '/v0/webui/tasks') {
    writeJson(ctx, 200, { ok: true, tasks: hub.listActiveTasks() });
    return true;
  }
  if (method === 'GET' && pathname === '/v0/webui/tasks/watch') {
    hub.watch(req, res);
    return true;
  }
  writeJson(ctx, 405, { ok: false, error: 'method_not_allowed' });
  return true;
}

module.exports = {
  handleWebUiTaskRoutes
};
