'use strict';

const {
  buildControlPlaneEndpointHints
} = require('./control-plane-endpoint-hints');
const {
  handleWebUiControlPlaneDeviceRoutes
} = require('./webui-control-plane-device-routes');

async function handleListEndpointHints(ctx) {
  const result = buildControlPlaneEndpointHints(ctx);
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    ...result
  });
  return true;
}

async function handleWebUiControlPlaneRoutes(ctx) {
  const { method, pathname } = ctx;

  if (method === 'GET' && pathname === '/v0/webui/control-plane/endpoints') {
    return handleListEndpointHints(ctx);
  }

  return handleWebUiControlPlaneDeviceRoutes(ctx);
}

module.exports = {
  handleWebUiControlPlaneRoutes
};
