'use strict';

/**
 * 本机入口转发管理（nginx / caddy / frp）的 WebUI 管理面：`GET /v0/webui/toolkit/edge`、
 * `GET /v0/webui/toolkit/edge/plan`、`POST /v0/webui/toolkit/edge/apply`。
 *
 * 与 CLI（`aih edge` / `scripts/aih-edge.js`）共用同一个 `EdgeProxyService`：界面里看到的
 * 是服务端真实探测结果，落盘那条链（备份 → 写入 → 校验 → 重载 → 失败回滚）只有一份实现，
 * 不存在「界面自己拼配置」的第二条路径。
 */

const { readRequestBody, writeJson: sharedWriteJson } = require('./http-utils');
const { EdgeProxyService } = require('../cli/services/toolkit/edge-proxy/edge-proxy-service');

const ROUTE_PREFIX = '/v0/webui/toolkit/edge';
const MAX_JSON_BODY_BYTES = 64 * 1024;
const KINDS = new Set(['frp', 'nginx', 'caddy']);
const MODES = new Set(['split', 'passthrough', 'http-only']);

// 落盘会同步 spawn `nginx -t` / `caddy validate` / `frpc verify`（单次最长 ~15s），两次并发
// 只会踩同一份配置文件，因此同一时刻只放行一次（busy → 429）。
let applyInFlight = false;

function edgeErrorStatus(code) {
  const value = String(code || '');
  if (value === 'edge_unknown_provider' || value === 'edge_domain_required' || value === 'edge_remote_port_required' || value === 'edge_invalid_mode') return 400;
  if (value === 'edge_config_not_found') return 404;
  if (value === 'edge_provider_not_installed') return 409;
  if (value === 'edge_config_not_writable') return 403;
  if (value === 'edge_config_rejected') return 422;
  if (value === 'edge_apply_busy') return 429;
  return 500;
}

/**
 * 转发目标 = AIH 自己**实际监听**的端口（不另开端口）。
 * 最可靠的一手证据是本次请求落到的本地监听口（`req.socket.localPort`）——AIH 换过端口时
 * deps 里的配置值可能是旧的；拿不到才依次退回配置/状态。
 */
function resolveAihPort(ctx = {}, req = null) {
  const deps = ctx.deps || {};
  const options = deps.options || {};
  const candidates = [
    req && req.socket && req.socket.localPort,
    ctx.serverPort,
    deps.serverPort,
    options.port,
    ctx.state && ctx.state.serverPort
  ];
  for (const candidate of candidates) {
    const port = Number(candidate);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  return 0;
}

function buildService(ctx = {}, req = null) {
  const deps = ctx.deps || {};
  const aihPort = resolveAihPort(ctx, req);
  // 组合根可注入（测试/嵌入场景给一份带假 fs、假执行器的实例）；默认用进程环境真实探测。
  if (typeof deps.createEdgeProxyService === 'function') {
    return deps.createEdgeProxyService({ aihPort: aihPort || undefined });
  }
  return new EdgeProxyService({
    fs: ctx.fs,
    aihPort: aihPort || undefined,
    // 探测本机装了哪个 / 配置在哪，靠的就是进程环境变量（AIH_EDGE_* / HOME 等）。
    env: process.env
  });
}

async function readJsonBody(req, ctx = {}, maxBytes = MAX_JSON_BODY_BYTES) {
  const read = ctx.readRequestBody || readRequestBody;
  const buffer = await read(req, { maxBytes });
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function planOptionsFromQuery(url) {
  const provider = String(url.searchParams.get('provider') || '').trim() || 'nginx';
  const mode = String(url.searchParams.get('mode') || '').trim() || 'split';
  const domain = String(url.searchParams.get('domain') || '').trim();
  const remotePort = String(url.searchParams.get('remotePort') || '').trim();
  return {
    provider,
    mode,
    domain,
    remotePort: remotePort ? Number(remotePort) : undefined,
    udp: url.searchParams.get('udp') !== '0'
  };
}

/**
 * Routes handler for /v0/webui/toolkit/edge/*
 */
async function handleWebUiEdgeProxyRoutes(req, res, method, pathname, ctx = {}) {
  if (!pathname.startsWith(ROUTE_PREFIX)) return false;
  const write = ctx.writeJson || sharedWriteJson;

  try {
    // 1. 现状：本机装了哪些边缘件、配置在哪、能不能写、AIH 端口是多少。
    if (method === 'GET' && pathname === ROUTE_PREFIX) {
      const service = buildService(ctx, req);
      write(res, 200, { ok: true, platform: process.platform, aihPort: service.aihPort, ...service.status() });
      return true;
    }

    // 2. 只生成、不落盘：界面拿到的就是 apply 会写的那份内容。
    if (method === 'GET' && pathname === `${ROUTE_PREFIX}/plan`) {
      const url = new URL(req.url || pathname, 'http://localhost');
      const { provider, mode, domain, remotePort, udp } = planOptionsFromQuery(url);
      if (!KINDS.has(provider)) {
        write(res, 400, { ok: false, error: 'edge_unknown_provider', provider });
        return true;
      }
      if (provider === 'nginx' && !MODES.has(mode)) {
        write(res, 400, { ok: false, error: 'edge_invalid_mode', mode });
        return true;
      }
      const service = buildService(ctx, req);
      const plan = service.plan(provider, {
        domain,
        mode,
        remotePort,
        udp,
        aihPort: service.aihPort
      });
      write(res, 200, { ok: true, plan });
      return true;
    }

    // 3. 落盘：备份 → 写入 → 校验 → 重载；校验不过整体回滚。
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/apply`) {
      if (applyInFlight) {
        write(res, 429, { ok: false, error: 'edge_apply_busy' });
        return true;
      }
      let body;
      try {
        body = await readJsonBody(req, ctx);
      } catch (_error) {
        write(res, 400, { ok: false, error: 'invalid_json_body' });
        return true;
      }
      const provider = String(body.provider || '').trim();
      const mode = String(body.mode || 'split').trim();
      if (!KINDS.has(provider)) {
        write(res, 400, { ok: false, error: 'edge_unknown_provider', provider });
        return true;
      }
      if (provider === 'nginx' && !MODES.has(mode)) {
        write(res, 400, { ok: false, error: 'edge_invalid_mode', mode });
        return true;
      }
      const service = buildService(ctx, req);
      applyInFlight = true;
      let result;
      try {
        result = service.apply(provider, {
          domain: String(body.domain || '').trim(),
          mode,
          remotePort: body.remotePort ? Number(body.remotePort) : undefined,
          udp: body.udp !== false,
          aihPort: service.aihPort,
          reload: body.reload !== false
        });
      } finally {
        applyInFlight = false;
      }
      write(res, result.ok ? 200 : edgeErrorStatus(result.error), result);
      return true;
    }

    return false;
  } catch (error) {
    const code = String((error && error.code) || '').trim();
    write(res, edgeErrorStatus(code), {
      ok: false,
      error: code || 'edge_request_failed',
      message: String((error && error.message) || error || '')
    });
    return true;
  }
}

module.exports = {
  handleWebUiEdgeProxyRoutes,
  ROUTE_PREFIX
};
