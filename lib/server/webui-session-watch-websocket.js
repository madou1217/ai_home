'use strict';

// Legacy Node-first/private listener compatibility only: Go owns the WebSocket
// handshake, first-frame authentication and event subscription. This adapter
// carries bytes with socket backpressure; it never decodes SSE/JSON or subscribes.
const http = require('node:http');
const net = require('node:net');
const { createHash } = require('node:crypto');

const SESSION_WATCH_WEBSOCKET_PATH = '/v0/webui/sessions/watch/ws';
const BRIDGE_KEY_HEADER = 'x-aih-watch-credential-sha256';
const CONNECT_TIMEOUT_MS = 5000;

function resolveTarget(ctx) {
  const host = typeof ctx.getGoCoreHost === 'function' ? ctx.getGoCoreHost() : ctx.goCoreHost;
  const status = host && typeof host.status === 'function' ? host.status() : null;
  if (!status || status.state !== 'ready' || !status.endpoint) return null;
  let url;
  try { url = new URL(status.endpoint); } catch (_error) { return null; }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || hostname === '::1'
    || (net.isIP(hostname) === 4 && hostname.startsWith('127.'));
  if (url.protocol !== 'http:' || !loopback || url.username || url.password) return null;
  const internalKey = typeof host.managementKey === 'function' ? host.managementKey() : '';
  const externalKey = typeof ctx.getRequiredManagementKey === 'function'
    ? ctx.getRequiredManagementKey() : ctx.requiredManagementKey;
  if (typeof internalKey !== 'string' || !internalKey || /[\r\n\0]/.test(internalKey)
    || typeof externalKey !== 'string' || !externalKey || externalKey.length > 8192) return null;
  return { hostname, port: Number(url.port) || 80, internalKey, externalKey };
}

function createSessionWatchWebSocketServer(ctx = {}) {
  const connections = new Set();
  let stopped = false;
  const reject = (socket, status) => {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  return {
    handleUpgrade(req, socket, head) {
      const target = !stopped && resolveTarget(ctx);
      if (!target) { reject(socket, '503 Service Unavailable'); return; }
      if (req.method !== 'GET') { reject(socket, '405 Method Not Allowed'); return; }
      if (typeof req.headers.host !== 'string' || !req.headers.host) { reject(socket, '400 Bad Request'); return; }
      // Never forward a client-supplied bridge digest or internal Authorization.
      // Preserve the browser-visible Host/Origin pair for Go's origin gate.
      const headers = {
        host: req.headers.host,
        connection: 'Upgrade',
        upgrade: 'websocket',
        authorization: `Bearer ${target.internalKey}`,
        [BRIDGE_KEY_HEADER]: createHash('sha256').update(target.externalKey).digest('hex')
      };
      for (const name of ['origin', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']) {
        if (req.headers[name] !== undefined) headers[name] = req.headers[name];
      }
      socket.pause();
      let upstream = null;
      let closed = false;
      let connected = false;
      let failing = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        connections.delete(close);
        request.destroy();
        if (upstream) upstream.destroy();
        socket.destroy();
      };
      const request = http.request({
        hostname: target.hostname, port: target.port, method: 'GET',
        path: SESSION_WATCH_WEBSOCKET_PATH, headers, agent: false
      });
      const fail = (status) => {
        if (closed || failing) return;
        failing = true;
        clearTimeout(timer);
        request.destroy();
        if (socket.destroyed) { close(); return; }
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, close);
      };
      const timer = setTimeout(() => fail('504 Gateway Timeout'), CONNECT_TIMEOUT_MS);
      timer.unref();
      connections.add(close);
      socket.once('close', close);
      socket.once('error', close);
      request.once('upgrade', (response, peer, upstreamHead) => {
        clearTimeout(timer);
        if (closed || stopped || socket.destroyed) { peer.destroy(); close(); return; }
        upstream = peer;
        connected = true;
        socket.setNoDelay(true);
        upstream.setNoDelay(true);
        const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
        }
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head && head.length) upstream.write(head);
        upstream.once('close', close);
        upstream.once('error', close);
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.resume();
      });
      request.once('response', (response) => {
        clearTimeout(timer);
        response.resume();
        fail(`${response.statusCode} ${http.STATUS_CODES[response.statusCode] || 'Unavailable'}`);
      });
      request.once('error', () => {
        if (!connected && !closed) fail('503 Service Unavailable');
        else close();
      });
      request.end();
    },
    close() {
      stopped = true;
      for (const close of connections) close();
    }
  };
}

module.exports = { SESSION_WATCH_WEBSOCKET_PATH, createSessionWatchWebSocketServer };
