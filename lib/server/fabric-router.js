'use strict';

const { buildFabricDescriptor } = require('./fabric-descriptor');
const { authorizeManagementKey } = require('./management-key-auth');
const { createFabricWebrtcSignalingStore } = require('./fabric-webrtc-signaling');
const {
  heartbeatFabricNode,
  listFabricRegistry,
  registerFabricNode
} = require('./fabric-role-registry');
const {
  buildTransportReadinessReport
} = require('./fabric-transport-readiness');
const {
  handleFabricBrokerProxyRequest
} = require('./fabric-broker-router');
const {
  WEBRTC_NODE_CONNECT_PATH,
  answerWebrtcNodeConnection
} = require('./remote/webrtc-management-adapter');

function firstHeaderValue(headers, name) {
  const value = headers && headers[name];
  return String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
}

function inferRequestEndpoint(ctx) {
  const headers = ctx.req && ctx.req.headers ? ctx.req.headers : {};
  const host = firstHeaderValue(headers, 'x-forwarded-host') || firstHeaderValue(headers, 'host');
  if (!host) return '';
  const proto = firstHeaderValue(headers, 'x-forwarded-proto')
    || (ctx.url && ctx.url.protocol ? String(ctx.url.protocol).replace(/:$/, '') : 'http');
  return `${proto || 'http'}://${host}`;
}

function writePublicFabricHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('cache-control', 'no-store');
}

function buildDescriptorForRequest(ctx) {
  return buildFabricDescriptor({
    options: ctx.options,
    state: ctx.state,
    requiredManagementKey: ctx.requiredManagementKey,
    endpoint: inferRequestEndpoint(ctx)
  });
}

async function readJsonPayload(ctx) {
  if (!ctx.deps || typeof ctx.deps.readRequestBody !== 'function') return {};
  const body = await ctx.deps.readRequestBody(ctx.req, { maxBytes: 1024 * 1024 }).catch(() => null);
  if (!body) return {};
  try {
    return body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
  } catch (_error) {
    return null;
  }
}

function fabricLabErrorStatus(code) {
  if (code === 'fabric_webrtc_room_not_found') return 404;
  if (code === 'fabric_webrtc_signal_payload_too_large') return 413;
  return 400;
}

function fabricRegistryErrorStatus(code) {
  if (code === 'unauthorized_management') return 401;
  if (code === 'management_key_not_configured') return 503;
  if (code === 'fabric_node_not_found') return 404;
  return 400;
}

function fabricWebrtcNodeErrorStatus(code) {
  if (code === 'unauthorized_relay_node') return 401;
  if (code === 'relay_node_not_found') return 404;
  if (code === 'missing_relay_node_id' || code === 'invalid_webrtc_offer') return 400;
  if (code === 'remote_webrtc_request_timeout') return 504;
  if (code === 'webrtc_runtime_unavailable') return 500;
  return 502;
}

function authorizeFabricRequest(ctx) {
  return authorizeManagementKey({
    req: ctx.req,
    requiredManagementKey: ctx.requiredManagementKey,
    deps: ctx.deps
  });
}

function writeFabricForbidden(ctx, authorization) {
  const error = String((authorization && authorization.error) || 'unauthorized_management');
  ctx.deps.writeJson(ctx.res, fabricRegistryErrorStatus(error), {
    ok: false,
    error
  });
}

function requireFabricManagement(ctx) {
  const authorization = authorizeFabricRequest(ctx);
  if (authorization.ok) return true;
  writeFabricForbidden(ctx, authorization);
  return false;
}

function getWebrtcSignalingStore(ctx) {
  if (ctx.deps && ctx.deps.fabricWebrtcSignalingStore) return ctx.deps.fabricWebrtcSignalingStore;
  if (!getWebrtcSignalingStore.defaultStore) {
    getWebrtcSignalingStore.defaultStore = createFabricWebrtcSignalingStore();
  }
  return getWebrtcSignalingStore.defaultStore;
}

function parseWebrtcRoomPath(pathname) {
  const match = String(pathname || '').match(/^\/v0\/fabric\/webrtc\/signaling\/rooms\/([^/]+)(?:\/(messages))?$/);
  if (!match) return null;
  return {
    roomId: decodeURIComponent(match[1] || ''),
    child: match[2] || ''
  };
}

async function handleFabricWebrtcRoomCreate(ctx) {
  writePublicFabricHeaders(ctx.res);
  if (!requireFabricManagement(ctx)) return true;
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const room = getWebrtcSignalingStore(ctx).createRoom(payload);
  ctx.deps.writeJson(ctx.res, 200, {
    ok: true,
    rpc: 'fabric.webrtc.signaling.room.create',
    result: room
  });
  return true;
}

async function handleFabricWebrtcMessagesCreate(ctx, roomId) {
  writePublicFabricHeaders(ctx.res);
  if (!requireFabricManagement(ctx)) return true;
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const message = getWebrtcSignalingStore(ctx).appendMessage(roomId, payload);
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'fabric.webrtc.signaling.message.create',
      result: message
    });
  } catch (error) {
    const code = String((error && error.code) || 'fabric_webrtc_signal_failed');
    ctx.deps.writeJson(ctx.res, fabricLabErrorStatus(code), {
      ok: false,
      error: code,
      message: String((error && error.message) || error || code)
    });
  }
  return true;
}

function handleFabricWebrtcMessagesList(ctx, roomId) {
  writePublicFabricHeaders(ctx.res);
  if (!requireFabricManagement(ctx)) return true;
  try {
    const result = getWebrtcSignalingStore(ctx).listMessages(roomId, {
      since: ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('since') : 0,
      limit: ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('limit') : 100
    });
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'fabric.webrtc.signaling.messages.list',
      result
    });
  } catch (error) {
    const code = String((error && error.code) || 'fabric_webrtc_messages_unavailable');
    ctx.deps.writeJson(ctx.res, fabricLabErrorStatus(code), {
      ok: false,
      error: code,
      message: String((error && error.message) || error || code)
    });
  }
  return true;
}

function handleFabricRegistryRead(ctx) {
  writePublicFabricHeaders(ctx.res);
  if (!requireFabricManagement(ctx)) return true;
  ctx.deps.writeJson(ctx.res, 200, {
    ok: true,
    rpc: 'fabric.registry.read',
    result: listFabricRegistry({
      fs: ctx.deps.fs,
      aiHomeDir: ctx.deps.aiHomeDir
    })
  });
  return true;
}

function handleFabricTransportReadiness(ctx) {
  writePublicFabricHeaders(ctx.res);
  if (!requireFabricManagement(ctx)) return true;
  const registry = listFabricRegistry({
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir
  });
  const nodeId = ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('nodeId') : '';
  const webrtcAvailable = typeof ctx.deps.requestWebrtcManagement === 'function'
    && (typeof ctx.deps.hasWebrtcManagementSession !== 'function'
      || ctx.deps.hasWebrtcManagementSession(nodeId, ctx.deps));
  ctx.deps.writeJson(ctx.res, 200, {
    ok: true,
    rpc: 'fabric.transport.readiness',
    result: buildTransportReadinessReport(registry, {
      nodeId,
      purpose: ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('purpose') : '',
      availableAdapters: [
        webrtcAvailable ? 'webrtc' : ''
      ].filter(Boolean)
    })
  });
  return true;
}

async function handleFabricWebrtcNodeConnect(ctx) {
  writePublicFabricHeaders(ctx.res);
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const result = await answerWebrtcNodeConnection({
      req: ctx.req,
      payload,
      endpoint: inferRequestEndpoint(ctx),
      remoteAddress: String(ctx.deps.clientIp || '').trim()
    }, ctx.deps);
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'fabric.webrtc.node.connect',
      result
    });
  } catch (error) {
    const code = String((error && error.code) || 'webrtc_node_connect_failed');
    ctx.deps.writeJson(ctx.res, fabricWebrtcNodeErrorStatus(code), {
      ok: false,
      error: code,
      message: String((error && error.message) || error || code)
    });
  }
  return true;
}

async function handleFabricNodeRegister(ctx) {
  writePublicFabricHeaders(ctx.res);
  if (!requireFabricManagement(ctx)) return true;
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const result = registerFabricNode(payload, {
      fs: ctx.deps.fs,
      aiHomeDir: ctx.deps.aiHomeDir
    });
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'fabric.registry.node.register',
      result
    });
  } catch (error) {
    const code = String((error && error.code) || 'fabric_node_register_failed');
    ctx.deps.writeJson(ctx.res, fabricRegistryErrorStatus(code), {
      ok: false,
      error: code,
      message: String((error && error.message) || error || code)
    });
  }
  return true;
}

async function handleFabricNodeHeartbeat(ctx) {
  writePublicFabricHeaders(ctx.res);
  if (!requireFabricManagement(ctx)) return true;
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const result = heartbeatFabricNode(payload, {
      fs: ctx.deps.fs,
      aiHomeDir: ctx.deps.aiHomeDir
    });
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'fabric.registry.node.heartbeat',
      result
    });
  } catch (error) {
    const code = String((error && error.code) || 'fabric_node_heartbeat_failed');
    ctx.deps.writeJson(ctx.res, fabricRegistryErrorStatus(code), {
      ok: false,
      error: code,
      message: String((error && error.message) || error || code)
    });
  }
  return true;
}

async function handleFabricRequest(ctx) {
  const { method, pathname, res, deps } = ctx;
  if (!String(pathname || '').startsWith('/v0/fabric')) return false;

  const handledBroker = await handleFabricBrokerProxyRequest(ctx);
  if (handledBroker) return true;

  if (method === 'OPTIONS' && String(pathname || '').startsWith('/v0/fabric/')) {
    writePublicFabricHeaders(res);
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (method === 'GET' && pathname === '/v0/fabric/descriptor') {
    writePublicFabricHeaders(res);
    deps.writeJson(res, 200, {
      ok: true,
      rpc: 'fabric.descriptor.read',
      result: buildDescriptorForRequest(ctx)
    });
    return true;
  }

  if (method === 'GET' && (pathname === '/v0/fabric/registry' || pathname === '/v0/fabric/registry/nodes')) {
    return handleFabricRegistryRead(ctx);
  }

  if (method === 'GET' && pathname === '/v0/fabric/transport/readiness') {
    return handleFabricTransportReadiness(ctx);
  }

  if (method === 'POST' && pathname === '/v0/fabric/registry/nodes') {
    return handleFabricNodeRegister(ctx);
  }

  if (method === 'POST' && pathname === '/v0/fabric/registry/heartbeat') {
    return handleFabricNodeHeartbeat(ctx);
  }

  if (method === 'POST' && pathname === WEBRTC_NODE_CONNECT_PATH) {
    return handleFabricWebrtcNodeConnect(ctx);
  }

  if (method === 'POST' && pathname === '/v0/fabric/webrtc/signaling/rooms') {
    return handleFabricWebrtcRoomCreate(ctx);
  }

  const webRtcRoomPath = parseWebrtcRoomPath(pathname);
  if (webRtcRoomPath && method === 'GET' && !webRtcRoomPath.child) {
    return handleFabricWebrtcMessagesList(ctx, webRtcRoomPath.roomId);
  }

  if (webRtcRoomPath && method === 'GET' && webRtcRoomPath.child === 'messages') {
    return handleFabricWebrtcMessagesList(ctx, webRtcRoomPath.roomId);
  }

  if (webRtcRoomPath && method === 'POST' && webRtcRoomPath.child === 'messages') {
    return handleFabricWebrtcMessagesCreate(ctx, webRtcRoomPath.roomId);
  }

  deps.writeJson(res, 404, { ok: false, error: 'fabric_route_not_found' });
  return true;
}

module.exports = {
  handleFabricRequest
};
