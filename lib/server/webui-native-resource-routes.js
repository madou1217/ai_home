'use strict';

// WebUI 原生资源（plugin / skill / mcp）路由：
// 探测（含 60s SWR Doctor 缓存）、生命周期操作（install/enable/disable/remove/test/tools/call）与 Demo 验证
// 全部已迁移至 Go（webuitoolkitextapi + internal/runtime/nativeresources）；Node 侧仅零回落代理。

const path = require('node:path');
const { readRequestBody: sharedReadRequestBody } = require('./http-utils');
const { proxyWebuiGo } = require('./webui-go-proxy');

const ROOT_PATH = '/v0/webui/toolkit/native-resources';
const GO_ROOT = '/v1/management/webui/toolkit/native-resources';
const DEMO_ROOT = path.resolve(__dirname, '..', '..');
const DEMO_SOURCES = Object.freeze({
  plugin: path.join(DEMO_ROOT, 'examples/native-plugins/aih-demo'),
  skill: path.join(DEMO_ROOT, 'assets/provider-skills/aih-demo'),
  mcp: path.join(DEMO_ROOT, 'examples/mcp/aih-demo-server.js')
});
const MAX_BODY_BYTES = 128 * 1024;
const NATIVE_RESOURCE_PASS_STATUSES = [400, 404, 405, 409, 413];

function writeJsonResponse(ctx, status, value) {
  if (typeof ctx.writeJson === 'function') return ctx.writeJson(ctx.res, status, value);
  ctx.res.writeHead(status, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify(value));
  return undefined;
}

function matchNativeResourceRoute(method, pathname) {
  return pathname === ROOT_PATH && ['GET', 'POST'].includes(String(method || '').toUpperCase());
}

function isBodyTooLargeError(error) {
  const code = String((error && (error.code || error.message)) || '');
  return code === 'request_body_too_large' || code === 'native_resource_payload_too_large';
}

async function readJsonBody(ctx) {
  const read = typeof ctx.readRequestBody === 'function' ? ctx.readRequestBody : sharedReadRequestBody;
  const raw = await read(ctx.req, { maxBytes: MAX_BODY_BYTES });
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  return text.trim() ? JSON.parse(text) : {};
}

async function handleWebUiNativeResourceRequest(ctx = {}) {
  const method = String(ctx.method || (ctx.req && ctx.req.method) || '').toUpperCase();
  const pathname = String(ctx.pathname || '');
  if (!matchNativeResourceRoute(method, pathname)) return false;

  const proxyCtx = {
    ...ctx,
    method,
    writeJson: ctx.writeJson || ((res, status, data) => writeJsonResponse({ res }, status, data))
  };

  if (method === 'GET') {
    return proxyWebuiGo(proxyCtx, {
      method: 'GET',
      path: GO_ROOT,
      passStatuses: NATIVE_RESOURCE_PASS_STATUSES,
      useFullBody: true,
      message: 'Go Core 未就绪，原生资源状态不可用'
    });
  }

  let body;
  try {
    body = await readJsonBody(ctx);
  } catch (error) {
    if (isBodyTooLargeError(error)) {
      writeJsonResponse(ctx, 413, { ok: false, error: 'native_resource_payload_too_large' });
      return true;
    }
    writeJsonResponse(ctx, 400, { ok: false, error: 'native_resource_payload_invalid' });
    return true;
  }

  return proxyWebuiGo(proxyCtx, {
    method: 'POST',
    path: GO_ROOT,
    body: body || {},
    passStatuses: NATIVE_RESOURCE_PASS_STATUSES,
    useFullBody: true,
    message: 'Go Core 未就绪，原生资源操作不可用'
  });
}

module.exports = { ROOT_PATH, DEMO_SOURCES, matchNativeResourceRoute, handleWebUiNativeResourceRequest };
