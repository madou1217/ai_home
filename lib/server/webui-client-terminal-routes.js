'use strict';

const {
  listClientTerminals,
  resolveTerminalActionPlan,
  executeClientTerminalAction
} = require('../runtime/client-terminal');

function buildTerminalOptions(ctx = {}) {
  const deps = ctx.deps || {};
  return {
    ...deps,
    ...ctx,
    fs: ctx.fs || deps.fs,
    path: ctx.path || deps.path,
    env: ctx.env || deps.env,
    processObj: ctx.processObj || deps.processObj,
    spawn: ctx.spawn || deps.spawn,
    runPlan: deps.runTerminalPlan || ctx.runTerminalPlan
  };
}

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

async function readBody(ctx) {
  if (typeof ctx.readRequestBody === 'function') {
    const buffer = await ctx.readRequestBody(ctx.req, { maxBytes: 64 * 1024 });
    return buffer && buffer.length ? JSON.parse(buffer.toString('utf8')) : {};
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    ctx.req.on('data', (chunk) => { raw += String(chunk); });
    ctx.req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); }
    });
    ctx.req.on('error', reject);
  });
}

function errorStatus(error) {
  const code = String(error || '');
  if (code === 'confirmation_required') return 428;
  if (code.startsWith('unsupported_') || code.startsWith('terminal_')) return 400;
  return 500;
}

async function handleWebUiClientTerminalRoutes(req, res, method, pathname, ctx = {}) {
  if (!['/v0/webui/terminals', '/v0/webui/toolkit/terminals'].includes(pathname)
    && pathname !== '/v0/webui/toolkit/terminals/plan'
    && pathname !== '/v0/webui/toolkit/terminals/execute') return false;
  const routeCtx = { ...ctx, req, res };
  const options = buildTerminalOptions(routeCtx);
  if (method === 'GET' && (pathname === '/v0/webui/terminals' || pathname === '/v0/webui/toolkit/terminals')) {
    const terminals = listClientTerminals(options);
    writeJson(routeCtx, 200, {
      ok: true,
      platform: terminals[0] && terminals[0].platform ? terminals[0].platform : options.platform || '',
      terminals
    });
    return true;
  }
  if (method !== 'POST') {
    writeJson(routeCtx, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  let body;
  try {
    body = await readBody(routeCtx);
  } catch (_error) {
    writeJson(routeCtx, 400, { ok: false, error: 'invalid_terminal_payload' });
    return true;
  }
  if (pathname === '/v0/webui/toolkit/terminals/plan') {
    const result = resolveTerminalActionPlan(body, options);
    writeJson(routeCtx, result.ok ? 200 : errorStatus(result.error), result);
    return true;
  }
  if (pathname === '/v0/webui/toolkit/terminals/execute') {
    const result = await executeClientTerminalAction(body, options);
    writeJson(routeCtx, result.ok ? 200 : errorStatus(result.error), result);
    return true;
  }
  writeJson(routeCtx, 404, { ok: false, error: 'terminal_route_not_found' });
  return true;
}

module.exports = {
  buildTerminalOptions,
  handleWebUiClientTerminalRoutes
};
