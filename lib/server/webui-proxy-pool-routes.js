'use strict';

const { getProxyPoolService } = require('../cli/services/toolkit/proxy-pool/proxy-pool-service');

// 代理节点库的管理面：节点列表、分组与节点导入（ZCode 出口弹窗在用）。
// 订阅源的增删改与同步走订阅聚合器（webui-subscription-aggregator-routes.js）。
const ROUTE_PREFIX = '/v0/webui/toolkit/proxy-pool';
const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function routeError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
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
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_error) {
        reject(routeError('invalid_json_body'));
      }
    });
    req.on('error', fail);
  });
}

function errorStatus(errorCode) {
  const code = String(errorCode || '');
  if (code === 'proxy_group_not_found' || code === 'group_node_not_found') return 404;
  if (code === 'proxy_store_busy') return 409;
  if (
    code.startsWith('invalid_')
    || code.startsWith('unsupported_')
    || code.startsWith('missing_required_')
    || code === 'reserved_proxy_group_id'
    || code === 'no_valid_proxy_nodes_found'
    || code === 'subscription_url_requires_subscription_flow'
  ) return 422;
  if (code.endsWith('_required') || code === 'request_body_too_large') return 400;
  return 500;
}

function sendResult(res, result, successStatus = 200) {
  jsonResponse(res, result?.ok === false ? errorStatus(result.error) : successStatus, result);
}

function sendException(res, error) {
  const code = error.code || error.message || 'internal_error';
  jsonResponse(res, errorStatus(code), {
    ok: false,
    error: code,
    message: error.message && error.message !== code ? error.message : undefined
  });
}

async function handleWebUiProxyPoolRoutes(req, res, method, pathname, ctx = {}) {
  if (!pathname.startsWith(`${ROUTE_PREFIX}/`)) return false;
  const service = ctx.proxyPoolService || ctx.deps?.proxyPoolService || getProxyPoolService();
  const run = async (operation) => {
    try {
      sendResult(res, await operation());
    } catch (error) {
      sendException(res, error);
    }
    return true;
  };

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/nodes`) {
    return run(() => {
      const url = new URL(req.url, 'http://localhost');
      return service.listNodes({
        group: url.searchParams.get('group') || '',
        protocol: url.searchParams.get('protocol') || ''
      });
    });
  }

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/groups`) {
    return run(() => service.listGroups());
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/groups`) {
    return run(async () => service.upsertGroup(await parseJsonBody(req)));
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/groups/policy`) {
    return run(async () => {
      const body = await parseJsonBody(req);
      if (!body.id) throw routeError('proxy_group_id_required');
      return service.updateGroupPolicy(body.id, {
        strategy: body.strategy,
        failoverStrategy: body.failoverStrategy
      });
    });
  }

  if (method === 'DELETE' && pathname.startsWith(`${ROUTE_PREFIX}/groups/`)) {
    return run(() => service.deleteGroup(decodeURIComponent(pathname.slice(`${ROUTE_PREFIX}/groups/`.length))));
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/import`) {
    return run(async () => {
      const body = await parseJsonBody(req);
      if (typeof body.content !== 'string') throw routeError('proxy_import_content_required');
      return service.importNodes(body.content, body.subscriptionId || null);
    });
  }

  return false;
}

module.exports = {
  MAX_JSON_BODY_BYTES,
  errorStatus,
  handleWebUiProxyPoolRoutes,
  parseJsonBody
};
