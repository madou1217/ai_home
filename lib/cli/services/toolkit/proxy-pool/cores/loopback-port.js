'use strict';

/** 在回环地址上挑选可用端口（内核中立）：优先首选端口，其次按范围顺序找，跳过保留端口。 */
const DEFAULT_PORT_MIN = 10800;
const DEFAULT_PORT_MAX = 10832;

function defaultPortAvailable(port) {
  return new Promise((resolve) => {
    const server = require('node:net').createServer();
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      server.close(() => resolve(available));
    };
    server.once('error', () => finish(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => finish(true));
  });
}

async function chooseLoopbackPort(preferredPort = DEFAULT_PORT_MIN, options = {}) {
  const preferred = Number(preferredPort);
  const minPort = Number(options.minPort || DEFAULT_PORT_MIN);
  const maxPort = Number(options.maxPort || DEFAULT_PORT_MAX);
  const isPortAvailable = options.isPortAvailable || defaultPortAvailable;
  const reservedPorts = new Set((options.reservedPorts || []).map(Number));
  const candidates = [];
  if (Number.isInteger(preferred) && preferred >= 1 && preferred <= 65535) candidates.push(preferred);
  for (let port = minPort; port <= maxPort; port += 1) {
    if (!candidates.includes(port)) candidates.push(port);
  }
  for (const port of candidates) {
    if (reservedPorts.has(port)) continue;
    if (await isPortAvailable(port)) {
      return {
        ok: true,
        port,
        requestedPort: preferred,
        reused: port === preferred,
        reason: port === preferred ? 'preferred_port_available' : 'preferred_port_in_use'
      };
    }
  }
  return {
    ok: false,
    error: 'no_available_loopback_port',
    requestedPort: preferred,
    range: { min: minPort, max: maxPort }
  };
}

module.exports = {
  DEFAULT_PORT_MAX,
  DEFAULT_PORT_MIN,
  chooseLoopbackPort,
  defaultPortAvailable
};
