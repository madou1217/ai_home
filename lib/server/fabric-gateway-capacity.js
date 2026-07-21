'use strict';

const DEFAULT_FABRIC_GATEWAY_CONCURRENCY = 16;
const activeRequestsByServerId = new Map();

function acquireFabricGatewaySlot(serverId, requestedLimit) {
  const limitValue = Number(requestedLimit);
  const limit = Number.isInteger(limitValue) && limitValue > 0
    ? Math.min(limitValue, 128)
    : DEFAULT_FABRIC_GATEWAY_CONCURRENCY;
  const active = activeRequestsByServerId.get(serverId) || 0;
  if (active >= limit) return null;
  activeRequestsByServerId.set(serverId, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = Math.max(0, (activeRequestsByServerId.get(serverId) || 1) - 1);
    if (remaining === 0) activeRequestsByServerId.delete(serverId);
    else activeRequestsByServerId.set(serverId, remaining);
  };
}

module.exports = {
  DEFAULT_FABRIC_GATEWAY_CONCURRENCY,
  acquireFabricGatewaySlot
};
