'use strict';

const { readRequestBody, writeJson } = require('./http-utils');
const {
  getSubscriptionAggregatorService
} = require('../cli/services/toolkit/subscription-aggregator/aggregator-service');

const ROUTE_PREFIX = '/v0/webui/toolkit/subscription-aggregator';
const MAX_JSON_BODY_BYTES = 256 * 1024;

function errorStatus(errorCode) {
  const code = String(errorCode || '');
  if (code.endsWith('_not_found')) return 404;
  if (code === 'subscription_changed_during_sync' || code === 'proxy_store_busy') return 409;
  if (code.startsWith('subscription_fetch_') || code === 'subscription_http_error' || code === 'subscription_host_resolution_failed') return 502;
  if (
    code.startsWith('invalid_')
    || code.startsWith('unsupported_')
    || code.startsWith('too_many_')
    || code.startsWith('subscription_url_')
    || code.startsWith('subscription_redirect_')
    || code === 'subscription_response_too_large'
    || code === 'no_valid_proxy_nodes_found'
  ) return 422;
  if (code === 'request_body_too_large') return 413;
  return 500;
}

async function readJson(ctx, req) {
  const read = ctx.readRequestBody || readRequestBody;
  const buffer = await read(req, { maxBytes: MAX_JSON_BODY_BYTES });
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    const error = new Error('invalid_json_body');
    error.code = 'invalid_json_body';
    throw error;
  }
}

function pathId(pathname, prefix, suffix = '') {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return '';
  const raw = pathname.slice(prefix.length, pathname.length - suffix.length);
  if (!raw || raw.includes('/')) return '';
  return decodeURIComponent(raw);
}

/**
 * 订阅聚合器的管理面（WebUI，受 Management Key 保护）。公开的订阅拉取走
 * subscription-aggregator-public-route.js 的 /sub/<token>。
 */
async function handleWebUiSubscriptionAggregatorRoutes(req, res, method, pathname, ctx = {}) {
  if (pathname !== ROUTE_PREFIX && !pathname.startsWith(`${ROUTE_PREFIX}/`)) return false;
  const send = ctx.writeJson || writeJson;
  const service = ctx.subscriptionAggregatorService || getSubscriptionAggregatorService();
  const reply = (result, successStatus = 200) => {
    send(res, result?.ok === false ? errorStatus(result.error) : successStatus, result);
    return true;
  };

  try {
    if (method === 'GET' && pathname === ROUTE_PREFIX) return reply(service.getOverview());
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/profiles`) {
      return reply(service.saveProfile(await readJson(ctx, req)));
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/sources`) {
      return reply(await service.saveSource(await readJson(ctx, req)));
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/sources/sync`) {
      const body = await readJson(ctx, req);
      return reply(await service.syncSources(Array.isArray(body.ids) ? body.ids.map(String) : []));
    }

    const profilePrefix = `${ROUTE_PREFIX}/profiles/`;
    const sourcePrefix = `${ROUTE_PREFIX}/sources/`;
    if (method === 'POST' && pathId(pathname, profilePrefix, '/token')) {
      return reply(service.rotateToken(pathId(pathname, profilePrefix, '/token')));
    }
    if (method === 'GET' && pathId(pathname, profilePrefix, '/preview')) {
      const url = new URL(req.url || pathname, 'http://localhost');
      return reply(service.preview(pathId(pathname, profilePrefix, '/preview'), url.searchParams.get('format')));
    }
    if (method === 'DELETE' && pathId(pathname, profilePrefix)) {
      return reply(service.deleteProfile(pathId(pathname, profilePrefix)));
    }
    if (method === 'POST' && pathId(pathname, sourcePrefix, '/sync')) {
      return reply(await service.syncSource(pathId(pathname, sourcePrefix, '/sync')));
    }
    if (method === 'DELETE' && pathId(pathname, sourcePrefix)) {
      return reply(await service.deleteSource(pathId(pathname, sourcePrefix)));
    }
  } catch (error) {
    const code = error.code || 'subscription_aggregator_failed';
    send(res, errorStatus(code), {
      ok: false,
      error: code,
      message: error.message && error.message !== code ? error.message : undefined
    });
    return true;
  }
  return false;
}

module.exports = {
  ROUTE_PREFIX,
  handleWebUiSubscriptionAggregatorRoutes
};
