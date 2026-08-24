'use strict';

const {
  getAccountEgressCatalogService
} = require('../account/account-egress-catalog-service');

const ROUTE_PREFIX = '/v0/webui/account-egress/catalog';
const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;

function routeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_JSON_BODY_BYTES) {
        fail(routeError('request_body_too_large'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(routeError('invalid_json_body'));
      }
    });
    req.on('error', fail);
  });
}

function errorStatus(codeInput) {
  const code = String(codeInput || '');
  if (['node_not_found', 'proxy_group_not_found', 'subscription_not_found'].includes(code)) return 404;
  if (['proxy_store_busy', 'subscription_changed_during_sync'].includes(code)) return 409;
  if (
    code.startsWith('subscription_fetch_')
    || code === 'subscription_http_error'
    || code === 'subscription_host_resolution_failed'
  ) return 503;
  if (
    code.startsWith('invalid_')
    || code.startsWith('unsupported_')
    || code.startsWith('missing_required_')
    || code.startsWith('subscription_url_')
    || code === 'no_valid_proxy_nodes_found'
    || code === 'subscription_response_too_large'
    || code === 'subscription_redirect_limit_exceeded'
    || code === 'subscription_redirect_downgrade_blocked'
  ) return 422;
  if (code.endsWith('_required') || code === 'request_body_too_large') return 400;
  return 500;
}

function sendResult(res, result) {
  jsonResponse(res, result?.ok === false ? errorStatus(result.error) : 200, result);
}

function sendException(res, error) {
  const code = String(error?.code || error?.message || 'internal_error');
  jsonResponse(res, errorStatus(code), { ok: false, error: code });
}

function resolveService(ctx = {}) {
  return ctx.accountEgressCatalogService
    || ctx.deps?.accountEgressCatalogService
    || getAccountEgressCatalogService();
}

async function handleWebUiAccountEgressCatalogRoutes(req, res, method, pathname, ctx = {}) {
  if (pathname !== ROUTE_PREFIX && !pathname.startsWith(`${ROUTE_PREFIX}/`)) return false;
  const service = resolveService(ctx);

  try {
    if (method === 'GET' && pathname === `${ROUTE_PREFIX}/nodes`) {
      const url = new URL(req.url, 'http://localhost');
      sendResult(res, service.listNodes({
        group: url.searchParams.get('group') || '',
        protocol: url.searchParams.get('protocol') || ''
      }));
      return true;
    }
    if (method === 'GET' && pathname === `${ROUTE_PREFIX}/groups`) {
      sendResult(res, service.listGroups());
      return true;
    }
    if (method === 'GET' && pathname === `${ROUTE_PREFIX}/subscriptions`) {
      sendResult(res, service.listSubscriptions());
      return true;
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/nodes`) {
      sendResult(res, await service.upsertNode(await parseJsonBody(req)));
      return true;
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/groups`) {
      sendResult(res, await service.upsertGroup(await parseJsonBody(req)));
      return true;
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/groups/policy`) {
      const body = await parseJsonBody(req);
      if (!body.id) throw routeError('proxy_group_id_required');
      sendResult(res, await service.updateGroupPolicy(body.id, {
        strategy: body.strategy,
        failoverStrategy: body.failoverStrategy
      }));
      return true;
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/subscriptions`) {
      sendResult(res, await service.upsertSubscription(await parseJsonBody(req)));
      return true;
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/subscriptions/sync`) {
      const body = await parseJsonBody(req);
      if (!body.id) throw routeError('subscription_id_required');
      sendResult(res, await service.syncSubscription(body.id));
      return true;
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/import`) {
      const body = await parseJsonBody(req);
      if (typeof body.content !== 'string') throw routeError('proxy_import_content_required');
      sendResult(res, await service.importNodes(body.content, body.subscriptionId || null));
      return true;
    }

    const deletions = [
      ['nodes', 'deleteNode'],
      ['groups', 'deleteGroup'],
      ['subscriptions', 'deleteSubscription']
    ];
    if (method === 'DELETE') {
      for (const [resource, operation] of deletions) {
        const prefix = `${ROUTE_PREFIX}/${resource}/`;
        if (!pathname.startsWith(prefix)) continue;
        const id = decodeURIComponent(pathname.slice(prefix.length));
        if (!id) throw routeError(`${resource.slice(0, -1)}_id_required`);
        sendResult(res, await service[operation](id));
        return true;
      }
    }
  } catch (error) {
    sendException(res, error);
    return true;
  }

  return false;
}

module.exports = {
  MAX_JSON_BODY_BYTES,
  ROUTE_PREFIX,
  errorStatus,
  handleWebUiAccountEgressCatalogRoutes
};
