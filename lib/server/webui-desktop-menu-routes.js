'use strict';

const { buildDesktopMenuSnapshot } = require('./desktop-menu-model');
const { readAccountsFastSnapshot } = require('./webui-account-live');

function handleGetDesktopMenuRequest(ctx) {
  const snapshot = readAccountsFastSnapshot(ctx);
  const menu = buildDesktopMenuSnapshot(snapshot.accounts);
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    hydrating: Boolean(snapshot.hydrating),
    ...menu
  });
  return true;
}

module.exports = {
  handleGetDesktopMenuRequest
};
