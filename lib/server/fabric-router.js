'use strict';

const { buildFabricDescriptor } = require('./fabric-descriptor');
const {
  authorizeControlPlaneDeviceToken,
  consumeControlPlaneDeviceInvite
} = require('./control-plane-device-pairing');
const { createFabricWebrtcSignalingStore } = require('./fabric-webrtc-signaling');
const {
  heartbeatFabricNode,
  listFabricRegistry,
  registerFabricNode
} = require('./fabric-role-registry');
const {
  handleFabricBrokerProxyRequest
} = require('./fabric-broker-router');

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

function codeFromUrl(url) {
  return url && url.searchParams ? String(url.searchParams.get('code') || '').trim() : '';
}

function devicePairErrorStatus(code) {
  if (code === 'device_invite_not_found') return 404;
  if (code === 'device_invite_expired' || code === 'device_invite_already_consumed') return 410;
  return 400;
}

function fabricLabErrorStatus(code) {
  if (code === 'fabric_webrtc_room_not_found') return 404;
  if (code === 'fabric_webrtc_signal_payload_too_large') return 413;
  return 400;
}

function fabricRegistryErrorStatus(code) {
  if (code === 'unauthorized_control_plane_device') return 401;
  if (code === 'forbidden_control_plane_device_scope' || code === 'forbidden_fabric_node_owner') return 403;
  if (code === 'fabric_node_not_found') return 404;
  return 400;
}

function parseBearer(ctx) {
  const authorization = ctx.req && ctx.req.headers ? ctx.req.headers.authorization : '';
  if (ctx.deps && typeof ctx.deps.parseAuthorizationBearer === 'function') {
    return ctx.deps.parseAuthorizationBearer(authorization);
  }
  const match = String(authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function authorizeFabricDeviceScope(ctx, scope) {
  return authorizeControlPlaneDeviceToken(parseBearer(ctx), scope, {
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir
  });
}

function writeFabricForbidden(ctx, authorization) {
  const error = String((authorization && authorization.error) || 'unauthorized_control_plane_device');
  ctx.deps.writeJson(ctx.res, fabricRegistryErrorStatus(error), {
    ok: false,
    error
  });
}

function getWebrtcSignalingStore(ctx) {
  if (ctx.deps && ctx.deps.fabricWebrtcSignalingStore) return ctx.deps.fabricWebrtcSignalingStore;
  if (!getWebrtcSignalingStore.defaultStore) {
    getWebrtcSignalingStore.defaultStore = createFabricWebrtcSignalingStore();
  }
  return getWebrtcSignalingStore.defaultStore;
}

function buildFabricDevicePairWebRedirectUrl(url) {
  if (!url || !url.searchParams) return '';
  const code = String(url.searchParams.get('code') || '').trim();
  if (!code) return '';
  const marker = '/v0/fabric/device-pair';
  const markerIndex = String(url.pathname || '').indexOf(marker);
  const basePath = markerIndex > 0 ? url.pathname.slice(0, markerIndex) : '';
  const pairUrl = new URL(url.toString());
  const redirectUrl = new URL(`${basePath}/ui/server-setup`, `${url.protocol}//${url.host}`);
  redirectUrl.searchParams.set('pair', pairUrl.toString());
  return redirectUrl.toString();
}

function writeFabricDevicePairWebRedirect(ctx) {
  const redirectUrl = buildFabricDevicePairWebRedirectUrl(ctx.url);
  if (!redirectUrl) {
    ctx.deps.writeJson(ctx.res, 404, { ok: false, error: 'fabric_route_not_found' });
    return true;
  }
  writePublicFabricHeaders(ctx.res);
  ctx.res.statusCode = 302;
  ctx.res.setHeader('location', redirectUrl);
  ctx.res.end('');
  return true;
}

async function handleFabricDevicePairRequest(ctx) {
  writePublicFabricHeaders(ctx.res);
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const result = consumeControlPlaneDeviceInvite({
      ...payload,
      code: payload.code || codeFromUrl(ctx.url)
    }, {
      fs: ctx.deps.fs,
      aiHomeDir: ctx.deps.aiHomeDir
    });
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'fabric.device.pair',
      result: {
        device: result.device,
        token: result.token,
        fabric: buildDescriptorForRequest(ctx)
      }
    });
  } catch (error) {
    const code = String((error && error.code) || 'fabric_device_pair_failed');
    ctx.deps.writeJson(ctx.res, devicePairErrorStatus(code), {
      ok: false,
      error: code,
      message: String((error && error.message) || error || code)
    });
  }
  return true;
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
  const authorization = authorizeFabricDeviceScope(ctx, 'nodes:read');
  if (!authorization.ok) {
    writeFabricForbidden(ctx, authorization);
    return true;
  }
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

async function handleFabricNodeRegister(ctx) {
  writePublicFabricHeaders(ctx.res);
  const authorization = authorizeFabricDeviceScope(ctx, 'nodes:write');
  if (!authorization.ok) {
    writeFabricForbidden(ctx, authorization);
    return true;
  }
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const nodePayload = payload.node && typeof payload.node === 'object' ? payload.node : payload;
    const result = registerFabricNode({
      ...payload,
      node: {
        ...nodePayload,
        ownerDeviceId: payload.ownerDeviceId || authorization.device.id
      }
    }, {
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
  const authorization = authorizeFabricDeviceScope(ctx, 'nodes:write');
  if (!authorization.ok) {
    writeFabricForbidden(ctx, authorization);
    return true;
  }
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const result = heartbeatFabricNode(payload, {
      fs: ctx.deps.fs,
      aiHomeDir: ctx.deps.aiHomeDir,
      ownerDeviceId: authorization.device.id
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

  if (method === 'GET' && pathname === '/v0/fabric/device-pair') {
    return writeFabricDevicePairWebRedirect(ctx);
  }

  if (method === 'POST' && pathname === '/v0/fabric/device-pair') {
    return handleFabricDevicePairRequest(ctx);
  }

  if (method === 'GET' && (pathname === '/v0/fabric/registry' || pathname === '/v0/fabric/registry/nodes')) {
    return handleFabricRegistryRead(ctx);
  }

  if (method === 'POST' && pathname === '/v0/fabric/registry/nodes') {
    return handleFabricNodeRegister(ctx);
  }

  if (method === 'POST' && pathname === '/v0/fabric/registry/heartbeat') {
    return handleFabricNodeHeartbeat(ctx);
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
  buildFabricDevicePairWebRedirectUrl,
  handleFabricRequest
};
