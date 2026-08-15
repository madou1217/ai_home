'use strict';

const { getProxyPoolService } = require('../cli/services/toolkit/proxy-pool/proxy-pool-service');

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5e6) { // 5MB limit for large subscriptions
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * REST Route Dispatcher for /v0/webui/toolkit/proxy-pool/*
 */
async function handleWebUiProxyPoolRoutes(req, res, method, pathname, ctx = {}) {
  const service = getProxyPoolService();

  // 1. GET /v0/webui/toolkit/proxy-pool/nodes
  if (method === 'GET' && pathname === '/v0/webui/toolkit/proxy-pool/nodes') {
    try {
      const url = new URL(req.url, 'http://localhost');
      const group = url.searchParams.get('group') || '';
      const protocol = url.searchParams.get('protocol') || '';
      const result = service.listNodes({ group, protocol });
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 2. POST /v0/webui/toolkit/proxy-pool/nodes
  if (method === 'POST' && pathname === '/v0/webui/toolkit/proxy-pool/nodes') {
    try {
      const body = await parseJsonBody(req);
      const result = service.upsertNode(body);
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 3. DELETE /v0/webui/toolkit/proxy-pool/nodes/:id
  if (method === 'DELETE' && pathname.startsWith('/v0/webui/toolkit/proxy-pool/nodes/')) {
    try {
      const nodeId = pathname.slice('/v0/webui/toolkit/proxy-pool/nodes/'.length);
      const result = service.deleteNode(nodeId);
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 4. POST /v0/webui/toolkit/proxy-pool/import
  if (method === 'POST' && pathname === '/v0/webui/toolkit/proxy-pool/import') {
    try {
      const body = await parseJsonBody(req);
      const { content, subscriptionId } = body;
      const result = service.importNodes(content, subscriptionId);
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 5. GET /v0/webui/toolkit/proxy-pool/subscriptions
  if (method === 'GET' && pathname === '/v0/webui/toolkit/proxy-pool/subscriptions') {
    try {
      const result = service.listSubscriptions();
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 6. POST /v0/webui/toolkit/proxy-pool/subscriptions
  if (method === 'POST' && pathname === '/v0/webui/toolkit/proxy-pool/subscriptions') {
    try {
      const body = await parseJsonBody(req);
      const result = service.upsertSubscription(body);
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 7. POST /v0/webui/toolkit/proxy-pool/subscriptions/sync
  if (method === 'POST' && pathname === '/v0/webui/toolkit/proxy-pool/subscriptions/sync') {
    try {
      const body = await parseJsonBody(req);
      const subId = body.id;
      const result = await service.syncSubscription(subId);
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 8. DELETE /v0/webui/toolkit/proxy-pool/subscriptions/:id
  if (method === 'DELETE' && pathname.startsWith('/v0/webui/toolkit/proxy-pool/subscriptions/')) {
    try {
      const subId = pathname.slice('/v0/webui/toolkit/proxy-pool/subscriptions/'.length);
      const result = service.deleteSubscription(subId);
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 9. POST /v0/webui/toolkit/proxy-pool/ping
  if (method === 'POST' && pathname === '/v0/webui/toolkit/proxy-pool/ping') {
    try {
      const body = await parseJsonBody(req);
      if (body.nodeId) {
        const result = await service.pingNode(body.nodeId);
        jsonResponse(res, 200, result);
      } else {
        const result = await service.pingAllNodes(body.filter || {});
        jsonResponse(res, 200, result);
      }
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 10. GET /v0/webui/toolkit/proxy-pool/routing
  if (method === 'GET' && pathname === '/v0/webui/toolkit/proxy-pool/routing') {
    try {
      const result = service.getRouting();
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 11. POST /v0/webui/toolkit/proxy-pool/routing
  if (method === 'POST' && pathname === '/v0/webui/toolkit/proxy-pool/routing') {
    try {
      const body = await parseJsonBody(req);
      if (body.mode) {
        service.setRoutingMode(body.mode, body.activeOutboundNodeId);
      }
      if (body.rules) {
        service.updateRoutingRules(body.rules);
      }
      jsonResponse(res, 200, service.getRouting());
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 12. GET /v0/webui/toolkit/proxy-pool/dedicated-ports
  if (method === 'GET' && pathname === '/v0/webui/toolkit/proxy-pool/dedicated-ports') {
    try {
      const result = service.getDedicatedPorts();
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // 13. POST /v0/webui/toolkit/proxy-pool/dedicated-ports/toggle
  if (method === 'POST' && pathname === '/v0/webui/toolkit/proxy-pool/dedicated-ports/toggle') {
    try {
      const body = await parseJsonBody(req);
      const { nodeId, enabled, requestedPort } = body;
      const result = await service.toggleDedicatedPort(nodeId, Boolean(enabled), requestedPort);
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  return false;
}

module.exports = {
  handleWebUiProxyPoolRoutes
};
