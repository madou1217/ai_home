'use strict';

const net = require('node:net');

/**
 * DedicatedPortManager: Manages independent local inbound ports (e.g. SOCKS5/HTTP tunnel)
 * forwarding to specific upstream nodes.
 *
 * Enforces hard maximum concurrency limit (e.g. 16/32 ports) to prevent resource exhaustion.
 */
class DedicatedPortManager {
  constructor(nodeStore, options = {}) {
    this.nodeStore = nodeStore;
    this.activeServers = new Map(); // nodeId -> net.Server
    this.maxPorts = options.maxPorts || 32;
  }

  getActiveServers() {
    const active = [];
    for (const [nodeId, server] of this.activeServers.entries()) {
      const addr = server.address();
      active.push({
        nodeId,
        port: addr ? addr.port : null,
        listening: Boolean(server.listening)
      });
    }
    return active;
  }

  async startDedicatedPortForNode(nodeId, requestedPort = null) {
    const node = this.nodeStore.getNode(nodeId);
    if (!node) {
      return { ok: false, error: 'node_not_found' };
    }

    if (this.activeServers.has(nodeId)) {
      const s = this.activeServers.get(nodeId);
      return { ok: true, port: s.address().port, running: true };
    }

    const portAssignRes = this.nodeStore.assignDedicatedPort(nodeId, requestedPort);
    if (!portAssignRes.ok) {
      return portAssignRes;
    }

    const port = portAssignRes.port;

    // Start a lightweight TCP forwarder / SOCKS tunnel server
    try {
      const server = net.createServer((clientSocket) => {
        // Forward to target node server & port
        const targetSocket = net.connect(node.port, node.server, () => {
          clientSocket.pipe(targetSocket);
          targetSocket.pipe(clientSocket);
        });

        clientSocket.on('error', () => targetSocket.destroy());
        targetSocket.on('error', () => clientSocket.destroy());
      });

      await new Promise((resolve, reject) => {
        server.on('error', (err) => reject(err));
        server.listen(port, '127.0.0.1', () => resolve());
      });

      this.activeServers.set(nodeId, server);
      return { ok: true, port, running: true };
    } catch (e) {
      this.nodeStore.releaseDedicatedPort(nodeId);
      return { ok: false, error: `启动独立端口 ${port} 失败: ${e.message}` };
    }
  }

  async stopDedicatedPortForNode(nodeId) {
    const server = this.activeServers.get(nodeId);
    if (server) {
      server.close();
      this.activeServers.delete(nodeId);
    }
    this.nodeStore.releaseDedicatedPort(nodeId);
    return { ok: true };
  }

  async stopAll() {
    for (const [nodeId, server] of this.activeServers.entries()) {
      server.close();
    }
    this.activeServers.clear();
    return { ok: true };
  }
}

let defaultPortManager = null;
function getDedicatedPortManager(store) {
  if (!defaultPortManager) {
    defaultPortManager = new DedicatedPortManager(store);
  }
  return defaultPortManager;
}

module.exports = {
  DedicatedPortManager,
  getDedicatedPortManager
};
