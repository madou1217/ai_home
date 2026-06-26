'use strict';

const { normalizeId } = require('./remote/node-registry');
const { getLoopbackControlEndpointWarning } = require('../control-endpoint');
const {
  inferControlEndpoint
} = require('./control-plane-endpoint-hints');
const {
  createControlPlaneDeviceInvite,
  listControlPlaneDevices,
  listControlPlaneDeviceInvites,
  revokeControlPlaneDevice
} = require('./control-plane-device-pairing');

const DEVICE_INVITE_LOOPBACK_WARNING = 'Control Endpoint 指向 localhost/127.0.0.1；手机或其他设备会把它当成自己本机。请改用局域网候选、Tailscale/ZeroTier/WireGuard、FRP/SSH tunnel、Cloudflare Tunnel 或公网入口后重新生成。';

async function readJsonPayload(ctx) {
  const body = await ctx.readRequestBody(ctx.req, { maxBytes: 1024 * 1024 }).catch(() => null);
  if (!body) return {};
  try {
    return body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
  } catch (_error) {
    return null;
  }
}

function deviceDeps(ctx) {
  return {
    fs: ctx.fs,
    aiHomeDir: ctx.aiHomeDir
  };
}

function buildDeviceInviteWarnings(result) {
  const endpoint = result && result.invite ? result.invite.controlEndpoint : '';
  const warning = getLoopbackControlEndpointWarning(endpoint, DEVICE_INVITE_LOOPBACK_WARNING);
  return warning ? [warning] : [];
}

async function handleListDevices(ctx) {
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    devices: listControlPlaneDevices(deviceDeps(ctx))
  });
  return true;
}

async function handleListInvites(ctx) {
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    invites: listControlPlaneDeviceInvites(deviceDeps(ctx))
  });
  return true;
}

async function handleCreateInvite(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const result = createControlPlaneDeviceInvite({
      ...payload,
      controlEndpoint: payload.controlEndpoint || inferControlEndpoint(ctx)
    }, deviceDeps(ctx));
    ctx.writeJson(ctx.res, 200, { ok: true, ...result, warnings: buildDeviceInviteWarnings(result) });
  } catch (error) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: String((error && error.code) || 'device_invite_create_failed'),
      message: String((error && error.message) || error || 'device_invite_create_failed')
    });
  }
  return true;
}

async function handleRevokeDevice(ctx, deviceId) {
  try {
    const device = revokeControlPlaneDevice(deviceId, deviceDeps(ctx));
    ctx.writeJson(ctx.res, 200, { ok: true, device });
  } catch (error) {
    const code = String((error && error.code) || 'device_revoke_failed');
    ctx.writeJson(ctx.res, code === 'device_not_found' ? 404 : 400, {
      ok: false,
      error: code,
      message: String((error && error.message) || error || code)
    });
  }
  return true;
}

async function handleWebUiControlPlaneDeviceRoutes(ctx) {
  const { method, pathname } = ctx;

  if (method === 'GET' && pathname === '/v0/webui/control-plane/devices') {
    return handleListDevices(ctx);
  }
  if (method === 'GET' && pathname === '/v0/webui/control-plane/devices/invites') {
    return handleListInvites(ctx);
  }
  if (method === 'POST' && pathname === '/v0/webui/control-plane/devices/invites') {
    return handleCreateInvite(ctx);
  }

  const revokeMatch = pathname.match(/^\/v0\/webui\/control-plane\/devices\/([^/]+)\/revoke$/);
  if (method === 'POST' && revokeMatch) {
    return handleRevokeDevice(ctx, normalizeId(decodeURIComponent(revokeMatch[1])));
  }

  return false;
}

module.exports = {
  handleWebUiControlPlaneDeviceRoutes
};
