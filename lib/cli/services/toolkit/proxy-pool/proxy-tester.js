'use strict';

const net = require('node:net');

/**
 * ProxyTester: Probes TCP handshake and connection latency for proxy nodes.
 */

function testTcpLatency(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const cleanup = () => {
      if (!settled) {
        settled = true;
        socket.destroy();
      }
    };

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      const latencyMs = Date.now() - start;
      cleanup();
      resolve({ ok: true, latencyMs });
    });

    socket.on('timeout', () => {
      cleanup();
      resolve({ ok: false, latencyMs: -1, error: '连接超时' });
    });

    socket.on('error', (err) => {
      cleanup();
      resolve({ ok: false, latencyMs: -1, error: err.message || '握手失败' });
    });

    try {
      socket.connect(port, host);
    } catch (e) {
      cleanup();
      resolve({ ok: false, latencyMs: -1, error: e.message });
    }
  });
}

/**
 * Test a batch of proxy nodes with concurrency control
 */
async function testNodesLatency(nodes, concurrency = 10) {
  const results = {};
  const queue = [...nodes];

  async function worker() {
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || !node.server || !node.port) continue;
      const res = await testTcpLatency(node.server, node.port);
      results[node.id] = {
        ok: res.ok,
        latencyMs: res.latencyMs,
        error: res.error || null,
        testedAt: Date.now()
      };
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, nodes.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

module.exports = {
  testTcpLatency,
  testNodesLatency
};
