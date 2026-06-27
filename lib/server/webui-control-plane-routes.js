'use strict';

const {
  buildControlPlaneEndpointHints
} = require('./control-plane-endpoint-hints');
const {
  listControlPlaneProfiles,
  saveControlPlaneProfile,
  setActiveControlPlaneProfile,
  removeControlPlaneProfile
} = require('./control-plane-profile-store');
const {
  handleWebUiControlPlaneDeviceRoutes
} = require('./webui-control-plane-device-routes');

async function readJsonPayload(ctx) {
  const body = await ctx.readRequestBody(ctx.req, { maxBytes: 1024 * 1024 }).catch(() => null);
  if (!body) return {};
  try {
    return body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
  } catch (_error) {
    return null;
  }
}

function profileDeps(ctx) {
  return {
    fs: ctx.fs,
    aiHomeDir: ctx.aiHomeDir
  };
}

async function handleListEndpointHints(ctx) {
  const result = buildControlPlaneEndpointHints(ctx);
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    ...result
  });
  return true;
}

async function handleListProfiles(ctx) {
  const store = listControlPlaneProfiles(profileDeps(ctx));
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    profiles: store.profiles,
    activeProfileId: store.activeProfileId
  });
  return true;
}

async function handleSaveProfile(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const result = saveControlPlaneProfile(payload.profile || payload, {
      active: payload.active === true,
      activeProfileId: payload.activeProfileId
    }, profileDeps(ctx));
    ctx.writeJson(ctx.res, 200, {
      ok: true,
      profile: result.profile,
      profiles: result.store.profiles,
      activeProfileId: result.store.activeProfileId
    });
  } catch (error) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: String((error && error.code) || 'control_plane_profile_save_failed'),
      message: String((error && error.message) || error || 'control_plane_profile_save_failed')
    });
  }
  return true;
}

async function handleSetActiveProfile(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const store = setActiveControlPlaneProfile(payload.profileId, profileDeps(ctx));
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    profiles: store.profiles,
    activeProfileId: store.activeProfileId
  });
  return true;
}

async function handleRemoveProfile(ctx, profileId) {
  const store = removeControlPlaneProfile(profileId, profileDeps(ctx));
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    profiles: store.profiles,
    activeProfileId: store.activeProfileId
  });
  return true;
}

async function handleWebUiControlPlaneRoutes(ctx) {
  const { method, pathname } = ctx;

  if (method === 'GET' && pathname === '/v0/webui/control-plane/endpoints') {
    return handleListEndpointHints(ctx);
  }
  if (method === 'GET' && pathname === '/v0/webui/control-plane/profiles') {
    return handleListProfiles(ctx);
  }
  if (method === 'POST' && pathname === '/v0/webui/control-plane/profiles') {
    return handleSaveProfile(ctx);
  }
  if (method === 'POST' && pathname === '/v0/webui/control-plane/profiles/active') {
    return handleSetActiveProfile(ctx);
  }
  const removeMatch = pathname.match(/^\/v0\/webui\/control-plane\/profiles\/([^/]+)$/);
  if (method === 'DELETE' && removeMatch) {
    return handleRemoveProfile(ctx, decodeURIComponent(removeMatch[1]));
  }

  return handleWebUiControlPlaneDeviceRoutes(ctx);
}

module.exports = {
  handleWebUiControlPlaneRoutes
};
